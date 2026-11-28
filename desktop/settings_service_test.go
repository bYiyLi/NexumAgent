package main

import (
	"context"
	"errors"
	"runtime"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

type testLogin struct {
	status   LoginStatus
	fail     bool
	noEffect bool
	reads    int
	writes   int
}

func (l *testLogin) Status() (LoginStatus, error) { l.reads++; return l.status, nil }
func (l *testLogin) Set(enabled bool) error {
	l.writes++
	if l.fail {
		return errors.New("login operation failed")
	}
	if !l.noEffect {
		l.status = LoginStatus{Registered: enabled, State: "disabled"}
		if enabled {
			l.status.State = "enabled"
		}
	}
	return nil
}

type testNotifier struct {
	startErr error
	granted  bool
	requests int
	sends    []notifications.NotificationOptions
	sendErr  error
	shutdown int
}

func (n *testNotifier) ServiceStartup(context.Context, application.ServiceOptions) error {
	return n.startErr
}
func (n *testNotifier) ServiceShutdown() error                        { n.shutdown++; return nil }
func (n *testNotifier) CheckNotificationAuthorization() (bool, error) { return n.granted, nil }
func (n *testNotifier) RequestNotificationAuthorization() (bool, error) {
	n.requests++
	return n.granted, nil
}
func (n *testNotifier) SendNotification(o notifications.NotificationOptions) error {
	if n.sendErr != nil {
		return n.sendErr
	}
	n.sends = append(n.sends, o)
	return nil
}
func newTestSettingsService(t *testing.T) (*FoundationService, *testLogin, *testNotifier) {
	t.Helper()
	p, err := desktopstate.ResolveAt(t.TempDir(), desktopstate.Development)
	if err != nil {
		t.Fatal(err)
	}
	store, err := desktopstate.Open(p, desktopstate.Development)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	l := &testLogin{status: LoginStatus{State: "disabled"}}
	n := &testNotifier{}
	sys := &clientSystem{paths: p, profile: desktopstate.Development, login: l, notifications: n, permission: func(n nativeNotifier) (string, error) {
		ok, err := n.CheckNotificationAuthorization()
		if err != nil {
			return "unknown", err
		}
		if ok {
			return "granted", nil
		}
		return "notGranted", nil
	}}
	sys.hide.Store(true)
	s := &FoundationService{store: store, system: sys}
	if err := s.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.ServiceShutdown() })
	return s, l, n
}

func TestSettingsAuthoritativeReadAndClosePreference(t *testing.T) {
	s, l, n := newTestSettingsService(t)
	a, err := s.Settings()
	if err != nil || a.Login.Registered || a.NotificationPermission != "notGranted" || !a.Preferences.HideOnClose {
		t.Fatalf("defaults: %+v %v", a, err)
	}
	if n.requests != 0 || l.writes != 0 {
		t.Fatal("read mutated OS")
	}
	a, err = s.SetPreference("hideOnClose", false)
	if err != nil || a.Preferences.HideOnClose || s.system.hide.Load() {
		t.Fatalf("close behavior: %+v %v", a, err)
	}
	if _, err = s.SetPreference("profile", true); err == nil {
		t.Fatal("arbitrary preference accepted")
	}
	if _, err = s.SetPreference("resultNotifications", false); err == nil {
		t.Fatal("master-off child change accepted")
	}
	if a, err = s.SetLaunchAtLogin(true, "zh-CN"); err != nil || !a.Login.Registered {
		t.Fatalf("enable: %+v %v", a, err)
	}
	l.noEffect = true
	if _, err = s.SetLaunchAtLogin(false, "zh-CN"); err == nil {
		t.Fatal("unconfirmed disable reported success")
	}
	l.noEffect = false
	if a, err = s.SetLaunchAtLogin(false, "zh-CN"); err != nil || a.Login.Registered {
		t.Fatalf("disable: %+v %v", a, err)
	}
	if len(n.sends) != 0 {
		t.Fatal("notification sent with master off")
	}
}

func TestSettingsNotificationsEnforceMasterCategoryAndPermission(t *testing.T) {
	s, l, n := newTestSettingsService(t)
	if err := s.SendTestNotification("zh-CN"); err == nil {
		t.Fatal("test sent while master off")
	}
	a, err := s.SetPreference("desktopNotifications", true)
	if err != nil || !a.Preferences.DesktopNotifications || a.NotificationPermission != "notGranted" {
		t.Fatalf("permission independent: %+v %v", a, err)
	}
	if runtime.GOOS == "darwin" && n.requests != 1 {
		t.Fatal("explicit enable did not request permission")
	}
	if err = s.SendTestNotification("zh-CN"); err == nil || len(n.sends) != 0 {
		t.Fatal("denied notification sent")
	}
	n.granted = true
	if _, err = s.SetPreference("resultNotifications", false); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetLaunchAtLogin(true, "en-US"); err != nil || len(n.sends) != 0 {
		t.Fatal("disabled result category sent")
	}
	l.fail = true
	if _, err = s.SetLaunchAtLogin(false, "zh-CN"); err == nil || len(n.sends) != 1 || n.sends[0].Body != "登录启动设置失败" {
		t.Fatalf("actual error notification: %v %+v", err, n.sends)
	}
	l.fail = false
	if _, err = s.SetPreference("errorNotifications", false); err != nil {
		t.Fatal(err)
	}
	if err = s.SendTestNotification("en-US"); err != nil || len(n.sends) != 2 {
		t.Fatalf("test delivery: %v %+v", err, n.sends)
	}
	if n.sends[1].Title != desktopstate.Development.Name() {
		t.Fatal("wrong profile identity")
	}
	if err = s.SendTestNotification("arbitrary"); err == nil {
		t.Fatal("unsupported locale accepted")
	}
	n.sendErr = errors.New("native send failed")
	if err = s.SendTestNotification("zh-CN"); err == nil {
		t.Fatal("native send error suppressed")
	}
	if _, err = s.SetPreference("desktopNotifications", false); err != nil {
		t.Fatal(err)
	}
	a, err = s.SetPreference("desktopNotifications", true)
	if err != nil || a.Preferences.ErrorNotifications || a.Preferences.ResultNotifications {
		t.Fatalf("child choices lost: %+v %v", a, err)
	}
}

func TestSettingsDiagnosticsOnlyCurrentProfile(t *testing.T) {
	s, _, _ := newTestSettingsService(t)
	var opened []string
	s.system.openDirectory = func(path string, selectFile bool) error {
		if selectFile {
			t.Fatal("unexpected file selection")
		}
		opened = append(opened, path)
		return nil
	}
	for _, kind := range []string{"data", "logs"} {
		if err := s.OpenDiagnosticDirectory(kind, "en-US"); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.OpenDiagnosticDirectory("../outside", "en-US"); err == nil {
		t.Fatal("arbitrary path accepted")
	}
	if len(opened) != 2 || opened[0] != s.system.paths.Root || opened[1] != s.system.paths.Logs {
		t.Fatalf("wrong profile paths: %v", opened)
	}
}

func TestNotificationSetupFailureDoesNotBlockSettings(t *testing.T) {
	s, _, n := newTestSettingsService(t)
	if err := s.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	n.startErr = errors.New("native service unavailable")
	if err := s.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	a, err := s.Settings()
	if err != nil || a.NotificationPermission != "unavailable" {
		t.Fatalf("unavailable: %+v %v", a, err)
	}
	if _, err = s.SetPreference("desktopNotifications", true); err != nil {
		t.Fatal(err)
	}
	if err = s.SendTestNotification("en-US"); err == nil {
		t.Fatal("unavailable native service reported success")
	}
}
