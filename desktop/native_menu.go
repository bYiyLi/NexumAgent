package main

import (
	"encoding/binary"
	"errors"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const nativeMenuNavigationEvent = "desktop:menu-navigation"

// NativeMenuNavigation is process-local. It is a monotonic, read-only snapshot
// of the latest explicit native menu navigation, not persisted configuration.
type NativeMenuNavigation struct {
	Revision    uint64 `json:"revision"`
	Destination string `json:"destination"`
}

type nativeMenuState struct {
	mu           sync.Mutex
	systemLocale string
	navigation   NativeMenuNavigation
}

func (s *nativeMenuState) setSystemLocale(locale string) error {
	if locale != "zh-CN" && locale != "en-US" {
		return errors.New("unsupported system menu locale")
	}
	s.mu.Lock()
	s.systemLocale = locale
	s.mu.Unlock()
	return nil
}

func (s *nativeMenuState) locale(language string) string {
	if language == "zh-CN" || language == "en-US" {
		return language
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.systemLocale == "zh-CN" {
		return "zh-CN"
	}
	return "en-US"
}

func (s *nativeMenuState) navigate(destination string) NativeMenuNavigation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if destination == "settings" || destination == "about" {
		s.navigation.Revision++
		s.navigation.Destination = destination
	}
	return s.navigation
}

func (s *nativeMenuState) snapshot() NativeMenuNavigation {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.navigation
}

// The WebView resolves the first supported system language using the same
// algorithm as the visible UI. An explicit saved preference takes precedence.
// This binding is safe before Bootstrap ready: it changes only an in-memory hint.
func (s *FoundationService) SetNativeMenuSystemLocale(locale string) error {
	return s.nativeMenu.setSystemLocale(locale)
}

func (s *FoundationService) GetNativeMenuNavigation() (NativeMenuNavigation, error) {
	if err := s.requireReady(); err != nil {
		return NativeMenuNavigation{}, err
	}
	return s.nativeMenu.snapshot(), nil
}

type nativeMenuPresentation struct {
	header, open, settings, about, quit string
	canNavigate, canQuit                bool
}

func (s *nativeMenuState) presentation(snapshot BootstrapSnapshot, closing bool) nativeMenuPresentation {
	p := nativeMenuPresentation{
		header: snapshot.Info.Name + " · v" + snapshot.Info.Version,
		open:   "Open Main Window", settings: "Settings…", about: "About Nexum", quit: "Quit Nexum",
		canNavigate: snapshot.Phase == "ready" && !closing,
		canQuit:     snapshot.CanQuit && !closing,
	}
	if s.locale(snapshot.Info.Language) == "zh-CN" {
		p.open, p.settings, p.about, p.quit = "打开主窗口", "设置…", "关于 Nexum", "退出 Nexum"
	}
	return p
}

// Reuse the verified 16px PNG representation of the multi-size application
// ICO. A native menu must not receive the 1024px application bitmap.
func nativeMenuBrandIcon(ico []byte) []byte {
	if len(ico) < 6 || binary.LittleEndian.Uint32(ico[:4]) != 0x00010000 {
		return nil
	}
	count := int(binary.LittleEndian.Uint16(ico[4:6]))
	if len(ico) < 6+count*16 {
		return nil
	}
	for i := 0; i < count; i++ {
		entry := ico[6+i*16 : 6+(i+1)*16]
		if entry[0] != 16 || entry[1] != 16 {
			continue
		}
		n, off := uint64(binary.LittleEndian.Uint32(entry[8:12])), uint64(binary.LittleEndian.Uint32(entry[12:16]))
		if n > 0 && off >= uint64(6+count*16) && off+n <= uint64(len(ico)) {
			return ico[off : off+n]
		}
	}
	return nil
}

func installNativeMenu(app *application.App, tray *application.SystemTray, service *FoundationService, showWindow func(), closing func() bool) {
	boot := service.bootstrap
	state := &service.nativeMenu
	presentation := func() nativeMenuPresentation {
		return state.presentation(boot.snapshot(), closing())
	}
	p := presentation()
	menu := app.NewMenu()
	header := menu.Add(p.header).SetEnabled(false)
	if icon := nativeMenuBrandIcon(windowsIcon); len(icon) != 0 {
		header.SetBitmap(icon)
	}
	menu.AddSeparator()
	open := menu.Add(p.open).OnClick(func(*application.Context) { showWindow() })
	navigate := func(destination string) {
		if !presentation().canNavigate {
			return
		}
		request := state.navigate(destination)
		showWindow()
		app.Event.Emit(nativeMenuNavigationEvent, request.Revision)
	}
	settings := menu.Add(p.settings).SetEnabled(p.canNavigate).OnClick(func(*application.Context) { navigate("settings") })
	about := menu.Add(p.about).SetEnabled(p.canNavigate).OnClick(func(*application.Context) { navigate("about") })
	menu.AddSeparator()
	quit := menu.Add(p.quit).SetEnabled(p.canQuit).OnClick(func(*application.Context) {
		if presentation().canQuit {
			_ = service.QuitDesktop()
		}
	})
	tray.SetMenu(menu)
	tray.OnClick(showWindow)
	// Wails' default left click opens the menu on macOS and is a no-op on
	// Windows. Explicit callbacks give both platforms the same behavior.
	tray.OnRightClick(func() {
		application.InvokeSync(func() {
			if closing() {
				return
			}
			next := presentation()
			if next != p {
				header.SetLabel(next.header)
				open.SetLabel(next.open)
				settings.SetLabel(next.settings).SetEnabled(next.canNavigate)
				about.SetLabel(next.about).SetEnabled(next.canNavigate)
				quit.SetLabel(next.quit).SetEnabled(next.canQuit)
				tray.SetMenu(menu)
				p = next
			}
			tray.OpenMenu()
		})
	})
}
