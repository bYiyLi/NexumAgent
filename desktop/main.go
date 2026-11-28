package main

import (
	"embed"
	"log"

	"os"
	"runtime"
	"sync/atomic"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

//go:embed build/tray-template.png
var trayTemplateIcon []byte

//go:embed build/windows/icon.ico
var windowsIcon []byte

func main() {
	paths, err := desktopstate.Resolve(currentProfile)
	if err != nil {
		log.Print(err)
		showStartupError()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--desktop-update-helper" {
		if len(os.Args) != 3 {
			log.Fatal("invalid update helper invocation")
		}
		cfg, e := updateConfig(paths)
		if e != nil {
			log.Fatal(e)
		}
		if e = cfg.RunHelper(os.Args[2]); e != nil {
			log.Fatal(e)
		}
		return
	}
	// The Windows WebView needs a safe per-profile path before it can create
	// the native window. No database is opened in this early preflight.
	if runtime.GOOS == "windows" {
		if err = desktopstate.PreparePaths(paths, currentProfile); err != nil {
			log.Print(err)
			showStartupError()
			return
		}
	}
	var logs desktopLog
	defer logs.close()
	logger := logs.logger()

	// Wails acquires the profile-specific single-instance lock in New.
	// Only the winning process is allowed to open the profile's SQLite database.
	sys := &clientSystem{login: newLoginRegistration(currentProfile.AppID()), notifications: notifications.New(), permission: systemNotificationPermission, paths: paths, profile: currentProfile}
	service := &FoundationService{logger: logger, system: sys}
	boot := newBootstrap(service, paths, logger)
	service.bootstrap = boot
	boot.openLog = func() error { return logs.open(paths) }
	var window atomic.Pointer[application.WebviewWindow]
	var shuttingDown atomic.Bool
	var quitRequested atomic.Bool
	closing := func() bool { return shuttingDown.Load() || quitRequested.Load() }
	var app *application.App
	showWindow := func() {
		if closing() || window.Load() == nil {
			return
		}
		application.InvokeSync(func() {
			if closing() {
				return
			}
			if w := window.Load(); w != nil {
				if runtime.GOOS == "darwin" {
					app.Show()
				}
				w.Restore()
				w.Show()
				w.Focus()
			}
		})
	}
	app = application.New(application.Options{
		Name:        currentProfile.Name(),
		Description: "Nexum Agent management client",
		Icon:        appIcon,
		Logger:      logger,
		Services:    []application.Service{application.NewService(service)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               currentProfile.AppID(),
			OnSecondInstanceLaunch: func(application.SecondInstanceData) { showWindow() },
		},
		Mac:        application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: false},
		Windows:    application.WindowsOptions{DisableQuitOnLastWindowClosed: true, WebviewUserDataPath: paths.WebView},
		ShouldQuit: func() bool { return boot.canQuit() || quitRequested.Load() },
		OnShutdown: func() {
			shuttingDown.Store(true)
			boot.cancel()
		},
	})
	boot.emit = func(revision uint64) { app.Event.Emit("bootstrap:changed", revision) }
	service.capabilityEmit = func() { app.Event.Emit("capability:changed") }
	boot.quit = func() {
		if quitRequested.CompareAndSwap(false, true) {
			go app.Quit()
		}
	}
	sys.openDirectory = app.Env.OpenFileManager
	service.openAgentBrowser = app.Browser.OpenURL
	service.chooseSSHKey = func() (string, error) {
		return app.Dialog.OpenFile().CanChooseFiles(true).CanChooseDirectories(false).ShowHiddenFiles(true).PromptForSingleSelection()
	}
	sys.hide.Store(true)
	background, err := initialWindowBackground("system", app.Env.IsDarkMode())
	if err != nil {
		log.Print(err)
		showStartupError()
		return
	}
	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: currentProfile.Name(), URL: desktopStartURL(currentProfile, os.Args[1:]),
		Width: 400, Height: 680, MinWidth: 400, MaxWidth: 400, MinHeight: 680, MaxHeight: 680,
		Frameless: runtime.GOOS != "darwin", DisableResize: true,
		BackgroundType: application.BackgroundTypeSolid, BackgroundColour: background,
		MaximiseButtonState: application.ButtonDisabled, FullscreenButtonState: application.ButtonDisabled,
		// Use the AppKit frame and real traffic lights; extend the opaque Nexum content behind them.
		Mac: application.MacWindow{Backdrop: application.MacBackdropNormal, TitleBar: application.MacTitleBarHiddenInset, TabbingMode: application.MacWindowTabbingModeDisallowed},
	})
	window.Store(w)
	service.setCapabilityVisible(true)
	w.OnWindowEvent(events.Common.WindowHide, func(*application.WindowEvent) { service.setCapabilityVisible(false) })
	w.OnWindowEvent(events.Common.WindowMinimise, func(*application.WindowEvent) { service.setCapabilityVisible(false) })
	w.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) { service.setCapabilityVisible(!w.IsMinimised()) })
	w.OnWindowEvent(events.Common.WindowUnMinimise, func(*application.WindowEvent) { service.setCapabilityVisible(w.IsVisible()) })
	w.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if shuttingDown.Load() {
			return
		}
		e.Cancel()
		if !boot.canQuit() {
			return
		}
		if sys.hide.Load() {
			w.Hide()
		} else {
			boot.quit()
		}
	})
	tray := app.SystemTray.New()
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(trayTemplateIcon)
	} else {
		tray.SetIcon(windowsIcon).SetDarkModeIcon(windowsIcon)
	}
	tray.SetTooltip(currentProfile.Name())
	installNativeMenu(app, tray, service, showWindow, closing)
	if runtime.GOOS == "darwin" {
		app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) { showWindow() })
		app.Event.OnApplicationEvent(events.Mac.ApplicationDidHide, func(*application.ApplicationEvent) { service.setCapabilityVisible(false) })
		app.Event.OnApplicationEvent(events.Mac.ApplicationDidUnhide, func(*application.ApplicationEvent) { service.setCapabilityVisible(w.IsVisible() && !w.IsMinimised()) })
	}
	w.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { _ = boot.start(false) })
	runErr := app.Run()
	boot.stop()
	service.closeCapabilityMonitor()
	service.closeLifecycle()
	service.closeEnvironments()
	if service.store != nil {
		_ = service.store.Close()
	}
	logger.Info("desktop stopped", "profile", currentProfile)
	if runErr != nil {
		logger.Error("desktop failed", "error", runErr)
		showStartupError()
	}
}
