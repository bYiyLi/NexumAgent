package environment

import (
	"path/filepath"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
)

func TestKeySelectionGeneration(t *testing.T) {
	paths, err := desktopstate.ResolveAt(t.TempDir(), desktopstate.Development)
	if err != nil {
		t.Fatal(err)
	}
	store, err := desktopstate.Open(paths, desktopstate.Development)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	m := NewManager(store, nil)
	defer m.Close()
	a, err := m.BeginKeySelection()
	if err != nil {
		t.Fatal(err)
	}
	m.ClearKey()
	path := filepath.Join(t.TempDir(), "fixture-key")
	if _, err = m.FinishKeySelection(a, path); ErrorCode(err) != "stale_key_selection" {
		t.Fatal("cancelled native dialog accepted", err)
	}
	b, err := m.BeginKeySelection()
	if err != nil {
		t.Fatal(err)
	}
	c, err := m.BeginKeySelection()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.FinishKeySelection(b, path); ErrorCode(err) != "stale_key_selection" {
		t.Fatal("superseded native dialog accepted", err)
	}
	selection, err := m.FinishKeySelection(c, path)
	if err != nil || selection.Name != "fixture-key" || selection.Token == "" {
		t.Fatal("valid native selection rejected", err)
	}
	if _, err = m.FinishKeySelection(c, path); ErrorCode(err) != "stale_key_selection" {
		t.Fatal("native selection replay accepted", err)
	}
}
