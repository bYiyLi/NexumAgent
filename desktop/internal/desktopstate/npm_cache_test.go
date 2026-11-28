package desktopstate

import (
	"strings"
	"testing"
	"time"
)

func TestPublicNPMCacheUsesDesktopProfileDatabase(t *testing.T) {
	paths, err := ResolveAt(t.TempDir(), Development)
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open(paths, Development)
	if err != nil {
		t.Fatal(err)
	}
	key, at := strings.Repeat("a", 64), time.Date(2026, 11, 28, 0, 0, 0, 0, time.UTC)
	if err := store.SavePublicNPMVersion(key, "1.2.3", at); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(paths, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	version, observed, found, err := store.LoadPublicNPMVersion(key)
	if err != nil || !found || version != "1.2.3" || !observed.Equal(at) {
		t.Fatalf("cache %s %v %v %v", version, observed, found, err)
	}
	if _, _, _, err := store.LoadPublicNPMVersion("invalid"); err == nil {
		t.Fatal("invalid key accepted")
	}
}
