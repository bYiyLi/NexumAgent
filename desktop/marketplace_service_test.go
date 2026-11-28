package main

import (
	"errors"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
)

func TestOpenMarketplaceUsesBuildProfileAndPropagatesErrors(t *testing.T) {
	paths, err := desktopstate.ResolveAt(t.TempDir(), currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	store, err := desktopstate.Open(paths, currentProfile)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var opened []string
	s := &FoundationService{store: store, openAgentBrowser: func(url string) error {
		opened = append(opened, url)
		return nil
	}}
	if err := s.OpenMarketplace(); err != nil {
		t.Fatal(err)
	}
	want := "https://nexum.y2l.top/marketplace"
	if currentProfile == desktopstate.Development {
		want = "https://nexum-dev.y2l.top/marketplace"
	}
	if len(opened) != 1 || opened[0] != want {
		t.Fatalf("opened %v, want only %s", opened, want)
	}

	blocked := &FoundationService{openAgentBrowser: s.openAgentBrowser}
	if err := blocked.OpenMarketplace(); err == nil || len(opened) != 1 {
		t.Fatal("market opened before Desktop was ready")
	}
	blocked.store = store
	blocked.bootstrap = &bootstrapController{state: BootstrapSnapshot{Phase: "initializing"}}
	if err := blocked.OpenMarketplace(); err == nil || len(opened) != 1 {
		t.Fatal("market opened before bootstrap completed")
	}

	s.openAgentBrowser = nil
	if err := s.OpenMarketplace(); err == nil {
		t.Fatal("missing browser was accepted")
	}
	openErr := errors.New("open failed")
	s.openAgentBrowser = func(string) error { return openErr }
	if err := s.OpenMarketplace(); !errors.Is(err, openErr) {
		t.Fatalf("browser error not returned: %v", err)
	}
}
