package main

import (
	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"runtime"
	"testing"
)

func TestFoundationService(t *testing.T) {
	paths, err := desktopstate.ResolveAt(t.TempDir(), currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	store, err := desktopstate.Open(paths, currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &FoundationService{store: store}
	info, err := s.Info()
	if err != nil || info.Profile != string(currentProfile) || info.Name != currentProfile.Name() || info.Theme != "system" || info.Language != "system" || info.Platform != runtime.GOOS {
		t.Fatalf("invalid service info: %+v %v", info, err)
	}
	if err := s.SetLanguage("en-US"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	info, err = s.Info()
	if err != nil || info.Theme != "dark" || info.Language != "en-US" {
		t.Fatalf("theme not persisted: %+v %v", info, err)
	}
	if err := s.SetLanguage("invalid"); err == nil {
		t.Fatal("invalid language accepted")
	}
	if err := s.SetTheme("invalid"); err == nil {
		t.Fatal("invalid theme accepted")
	}
}
