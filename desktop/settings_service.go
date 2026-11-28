package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

type nativeNotifier interface {
	ServiceStartup(context.Context, application.ServiceOptions) error
	ServiceShutdown() error
	CheckNotificationAuthorization() (bool, error)
	RequestNotificationAuthorization() (bool, error)
	SendNotification(notifications.NotificationOptions) error
}

type ClientSettings struct {
	Preferences            desktopstate.Preferences `json:"preferences"`
	Login                  LoginStatus              `json:"login"`
	NotificationPermission string                   `json:"notificationPermission"`
}

type clientSystem struct {
	mu            sync.Mutex
	hide          atomic.Bool
	login         loginRegistration
	notifications nativeNotifier
	notifyReady   atomic.Bool
	permission    func(nativeNotifier) (string, error)
	openDirectory func(string, bool) error
	paths         desktopstate.Paths
	profile       desktopstate.Profile
}

func (s *FoundationService) ServiceStartup(ctx context.Context, opts application.ServiceOptions) error {
	if s.system == nil || s.system.notifications == nil {
		return nil
	}
	if err := s.system.notifications.ServiceStartup(ctx, opts); err != nil {
		s.logSettingsError("native notification setup", err)
		// Notification failure must never prevent opening Desktop.
		return nil
	}
	s.system.notifyReady.Store(true)
	return nil
}
func (s *FoundationService) ServiceShutdown() error {
	if s.system == nil || !s.system.notifyReady.Swap(false) {
		return nil
	}
	// The native event loop is stopping; never wait on an in-flight OS
	// permission dialog or file-manager call. No notification is scheduled.
	if !s.system.mu.TryLock() {
		return nil
	}
	defer s.system.mu.Unlock()
	return s.system.notifications.ServiceShutdown()
}
func (s *FoundationService) logSettingsError(operation string, err error) {
	if s.logger != nil {
		s.logger.Error("desktop settings operation failed", "operation", operation, "error", err)
	}
}
func (s *FoundationService) requireSystem() (*clientSystem, error) {
	if s.system == nil {
		return nil, errors.New("desktop system services unavailable")
	}
	return s.system, nil
}
func (s *FoundationService) settingsLocked() (ClientSettings, error) {
	p, err := s.store.Preferences()
	if err != nil {
		return ClientSettings{}, err
	}
	state := ClientSettings{Preferences: p, Login: LoginStatus{State: "unknown"}, NotificationPermission: "unavailable"}
	if s.system.login != nil {
		login, err := s.system.login.Status()
		if err == nil {
			state.Login = login
		} else {
			s.logSettingsError("login status", err)
		}
	}
	if s.system.notifyReady.Load() {
		status, err := s.system.permission(s.system.notifications)
		if err != nil {
			s.logSettingsError("notification permission", err)
			state.NotificationPermission = "unknown"
		} else {
			state.NotificationPermission = status
		}
	}
	return state, nil
}
func (s *FoundationService) Settings() (ClientSettings, error) {
	if e := s.requireReady(); e != nil {
		return ClientSettings{}, e
	}
	sys, err := s.requireSystem()
	if err != nil {
		return ClientSettings{}, err
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	return s.settingsLocked()
}

func (s *FoundationService) SetPreference(key string, enabled bool) (ClientSettings, error) {
	if e := s.requireReady(); e != nil {
		return ClientSettings{}, e
	}
	sys, err := s.requireSystem()
	if err != nil {
		return ClientSettings{}, err
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	p, err := s.store.Preferences()
	if err != nil {
		return ClientSettings{}, err
	}
	if (key == "errorNotifications" || key == "resultNotifications") && !p.DesktopNotifications {
		return ClientSettings{}, errors.New("desktop notifications are disabled")
	}
	if err = s.store.SetPreference(key, enabled); err != nil {
		return ClientSettings{}, err
	}
	if key == "hideOnClose" {
		sys.hide.Store(enabled)
	}
	// Permission is distinct from the saved app preference. A denial never
	// erases the user's preference or implies permission was granted.
	if key == "desktopNotifications" && enabled && runtime.GOOS == "darwin" && sys.notifyReady.Load() {
		if _, err := sys.notifications.RequestNotificationAuthorization(); err != nil {
			s.logSettingsError("request notification permission", err)
		}
	}
	return s.settingsLocked()
}

func (s *FoundationService) SetLaunchAtLogin(enabled bool, locale string) (ClientSettings, error) {
	if e := s.requireReady(); e != nil {
		return ClientSettings{}, e
	}
	if !validNotificationLocale(locale) {
		return ClientSettings{}, errors.New("unsupported notification locale")
	}
	sys, err := s.requireSystem()
	if err != nil {
		return ClientSettings{}, err
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	if sys.login == nil {
		return ClientSettings{}, errors.New("login registration unavailable")
	}
	if err = sys.login.Set(enabled); err != nil {
		s.logSettingsError("login registration", err)
		s.notifyLocked("error", locale, "登录启动设置失败", "Login item change failed")
		return ClientSettings{}, err
	}
	state, err := s.settingsLocked()
	if err != nil {
		return ClientSettings{}, err
	}
	if state.Login.State == "unknown" || state.Login.Registered != enabled {
		return ClientSettings{}, errors.New("login registration result could not be verified")
	}
	s.notifyLocked("result", locale, "登录启动设置已更新", "Login item setting updated")
	return state, nil
}

// Fixed, profile-owned paths only. The frontend chooses a semantic action,
// never an arbitrary filesystem path.
func (s *FoundationService) OpenDiagnosticDirectory(kind string, locale string) error {
	if s.bootstrap != nil && s.bootstrap.snapshot().Phase != "ready" && (kind != "logs" || !s.bootstrap.snapshot().CanViewLogs) {
		return errors.New("diagnostic directory unavailable during bootstrap")
	}
	if !validNotificationLocale(locale) {
		return errors.New("unsupported notification locale")
	}
	sys, err := s.requireSystem()
	if err != nil {
		return err
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	path, err := desktopstate.DiagnosticDirectory(sys.paths, sys.profile, kind)
	if err == nil {
		if sys.openDirectory == nil {
			err = errors.New("file manager unavailable")
		} else {
			err = sys.openDirectory(path, false)
		}
	}
	if err != nil {
		s.logSettingsError("open diagnostic directory", err)
		s.notifyLocked("error", locale, "无法打开客户端目录", "Could not open Desktop directory")
	}
	return err
}

func validNotificationLocale(locale string) bool { return locale == "zh-CN" || locale == "en-US" }

func (s *FoundationService) sendLocked(body string) error {
	sys := s.system
	if !sys.notifyReady.Load() {
		return errors.New("native notifications unavailable")
	}
	permission, err := sys.permission(sys.notifications)
	if err != nil {
		return err
	}
	if permission != "granted" {
		return errors.New("system notifications are not authorized")
	}
	id := fmt.Sprintf("%s-%d", sys.profile.AppID(), time.Now().UnixNano())
	return sys.notifications.SendNotification(notifications.NotificationOptions{ID: id, Title: sys.profile.Name(), Body: body})
}

// Real event delivery is best effort and cannot change the outcome of the
// operation that produced it. No arbitrary notification IPC is exposed.
func (s *FoundationService) notifyLocked(category, locale, zh, en string) {
	if s.requireReady() != nil {
		return
	}
	p, err := s.store.Preferences()
	if err != nil || !p.DesktopNotifications {
		return
	}
	if category == "error" && !p.ErrorNotifications || category == "result" && !p.ResultNotifications {
		return
	}
	if category != "error" && category != "result" {
		return
	}
	body := en
	if locale == "zh-CN" {
		body = zh
	}
	if err := s.sendLocked(body); err != nil {
		s.logSettingsError("send notification", err)
	}
}

func (s *FoundationService) SendTestNotification(locale string) error {
	if e := s.requireReady(); e != nil {
		return e
	}
	sys, err := s.requireSystem()
	if err != nil {
		return err
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	p, err := s.store.Preferences()
	if err != nil {
		return err
	}
	if !p.DesktopNotifications {
		return errors.New("desktop notifications are disabled")
	}
	if !sys.notifyReady.Load() {
		return errors.New("native notifications unavailable")
	}
	if !validNotificationLocale(locale) {
		return errors.New("unsupported notification locale")
	}
	if runtime.GOOS == "darwin" {
		if _, err := sys.notifications.RequestNotificationAuthorization(); err != nil {
			return err
		}
	}
	body := "Nexum Desktop notification test."
	if locale == "zh-CN" {
		body = "Nexum Desktop 通知测试。"
	}
	if err := s.sendLocked(body); err != nil {
		s.logSettingsError("test notification", err)
		return err
	}
	if s.logger != nil {
		s.logger.Info("desktop test notification accepted by OS", "profile", sys.profile)
	}
	return nil
}
