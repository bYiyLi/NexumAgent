package main

import (
	"bytes"
	"image/png"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
)

func TestNativeMenuPresentation(t *testing.T) {
	var state nativeMenuState
	snapshot := BootstrapSnapshot{
		Info:  DesktopInfo{Name: "Nexum Desktop Dev", Version: "0.1.0-dev", Language: "system"},
		Phase: "initializing", CanQuit: true,
	}
	p := state.presentation(snapshot, false)
	if p.header != "Nexum Desktop Dev · v0.1.0-dev" || p.canNavigate || !p.canQuit || p.open != "Open Main Window" {
		t.Fatalf("unexpected initial menu: %+v", p)
	}
	if err := state.setSystemLocale("zh-CN"); err != nil {
		t.Fatal(err)
	}
	snapshot.Phase = "ready"
	p = state.presentation(snapshot, false)
	if !p.canNavigate || !p.canQuit || p.open != "打开主窗口" || p.about != "关于 Nexum" {
		t.Fatalf("unexpected ready menu: %+v", p)
	}
	snapshot.Info.Language = "en-US"
	if state.presentation(snapshot, false).settings != "Settings…" {
		t.Fatal("saved explicit language must override system locale")
	}
	if err := state.setSystemLocale("invalid"); err == nil {
		t.Fatal("invalid locale accepted")
	}
	snapshot.Info.Language = "system"
	if state.presentation(snapshot, false).settings != "设置…" {
		t.Fatal("invalid locale changed the previous hint")
	}
	for _, phase := range []string{"storage", "configuration", "backup", "migration", "dataVerifying", "installing", "restarting"} {
		snapshot.Phase, snapshot.CanQuit = phase, false
		p = state.presentation(snapshot, false)
		if p.canNavigate || p.canQuit {
			t.Fatalf("critical phase %s not gated: %+v", phase, p)
		}
	}
	snapshot.Phase, snapshot.CanQuit = "ready", true
	p = state.presentation(snapshot, true)
	if p.canNavigate || p.canQuit {
		t.Fatal("closing menu is not gated")
	}
}

func TestNativeMenuNavigation(t *testing.T) {
	var state nativeMenuState
	if state.snapshot().Revision != 0 {
		t.Fatal("initial request must be empty")
	}
	if state.navigate("invalid").Revision != 0 {
		t.Fatal("unknown destination accepted")
	}
	first := state.navigate("settings")
	next := state.navigate("about")
	if first.Revision != 1 || next.Revision != 2 || next.Destination != "about" || state.snapshot() != next {
		t.Fatalf("unexpected snapshot: %+v", next)
	}
	if state.navigate("about").Revision != 3 {
		t.Fatal("repeated navigation must issue a new revision")
	}
	service := &FoundationService{bootstrap: &bootstrapController{state: BootstrapSnapshot{Phase: "installing"}}}
	if _, err := service.GetNativeMenuNavigation(); err == nil {
		t.Fatal("navigation binding bypassed bootstrap gate")
	}
	if err := service.SetNativeMenuSystemLocale("zh-CN"); err != nil {
		t.Fatal(err)
	}
}

func TestNativeMenuLanguagePersistence(t *testing.T) {
	paths, err := desktopstate.ResolveAt(t.TempDir(), currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	store, err := desktopstate.Open(paths, currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &FoundationService{store: store, bootstrap: &bootstrapController{state: BootstrapSnapshot{Phase: "ready", Info: baseDesktopInfo(), CanQuit: true}}}
	if err := s.SetNativeMenuSystemLocale("en-US"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLanguage("zh-CN"); err != nil {
		t.Fatal(err)
	}
	if language, err := store.Language(); err != nil || language != "zh-CN" {
		t.Fatalf("saved language: %s %v", language, err)
	}
	if s.nativeMenu.presentation(s.bootstrap.snapshot(), false).settings != "设置…" {
		t.Fatal("saved locale not reflected in native menu")
	}
	if err := s.SetLanguage("invalid"); err == nil {
		t.Fatal("invalid preference accepted")
	}
	if s.nativeMenu.presentation(s.bootstrap.snapshot(), false).settings != "设置…" {
		t.Fatal("failed save changed native locale")
	}
	if err := s.SetLanguage("system"); err != nil {
		t.Fatal(err)
	}
	if s.nativeMenu.presentation(s.bootstrap.snapshot(), false).settings != "Settings…" {
		t.Fatal("system language not restored")
	}
}

func TestNativeMenuBrandIcon(t *testing.T) {
	icon, err := png.Decode(bytes.NewReader(nativeMenuBrandIcon(windowsIcon)))
	if err != nil {
		t.Fatal(err)
	}
	if icon.Bounds().Dx() != 16 || icon.Bounds().Dy() != 16 {
		t.Fatal("native menu icon is not 16px")
	}
	if nativeMenuBrandIcon([]byte{0, 0, 1, 0, 1, 0}) != nil {
		t.Fatal("truncated ICO accepted")
	}
}
