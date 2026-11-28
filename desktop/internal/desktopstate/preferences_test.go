package desktopstate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPreferencesPersistence(t *testing.T) {
	base := t.TempDir()
	dev, _ := ResolveAt(base, Development)
	prod, _ := ResolveAt(base, Production)
	p, err := Open(dev, Development)
	if err != nil {
		t.Fatal(err)
	}
	want := Preferences{HideOnClose: true, ErrorNotifications: true, ResultNotifications: true}
	if got, err := p.Preferences(); err != nil || got != want {
		t.Fatalf("defaults: %+v %v", got, err)
	}
	for k, v := range map[string]bool{"hideOnClose": false, "desktopNotifications": true, "errorNotifications": false, "resultNotifications": false} {
		if err := p.SetPreference(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.SetPreference("profile", false); err == nil {
		t.Fatal("identity overwritten")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	p, err = Open(dev, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got, err := p.Preferences(); err != nil || got != (Preferences{DesktopNotifications: true}) {
		t.Fatalf("reopen: %+v %v", got, err)
	}
	var schema int
	if err := p.db.QueryRow("PRAGMA user_version").Scan(&schema); err != nil || schema != schemaVersion {
		t.Fatalf("schema: %d %v", schema, err)
	}
	other, err := Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if got, err := other.Preferences(); err != nil || got != want {
		t.Fatalf("profile isolation: %+v %v", got, err)
	}
	if _, err := p.db.Exec("UPDATE settings SET value='invalid' WHERE key='hideOnClose'"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Preferences(); err == nil {
		t.Fatal("invalid stored bool accepted")
	}
}

func TestDiagnosticDirectory(t *testing.T) {
	p, _ := ResolveAt(t.TempDir(), Development)
	s, err := Open(p, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for kind, want := range map[string]string{"data": p.Root, "logs": p.Logs} {
		if got, err := DiagnosticDirectory(p, Development, kind); err != nil || got != want {
			t.Fatalf("%s: %s %v", kind, got, err)
		}
	}
	if _, err := DiagnosticDirectory(p, Production, "data"); err == nil {
		t.Fatal("cross profile")
	}
	if _, err := DiagnosticDirectory(p, Development, "../outside"); err == nil {
		t.Fatal("arbitrary directory")
	}
	if err := os.Remove(p.Logs); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(p.Root), p.Logs); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := DiagnosticDirectory(p, Development, "logs"); err == nil {
		t.Fatal("redirected logs accepted")
	}
}
