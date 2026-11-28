package desktopstate

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileIsolationAndPersistence(t *testing.T) {
	base := t.TempDir()
	prod, err := ResolveAt(base, Production)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ResolveAt(base, Development)
	if err != nil {
		t.Fatal(err)
	}
	if prod.Root == dev.Root || prod.Database == dev.Database || prod.Logs == dev.Logs || prod.WebView == dev.WebView || Production.AppID() == Development.AppID() {
		t.Fatal("profiles overlap")
	}
	p, err := Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	d, err := Open(dev, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if got, err := d.Theme(); err != nil || got != "system" {
		t.Fatalf("dev theme = %q (%v)", got, err)
	}
	if err := d.SetTheme("light"); err != nil {
		t.Fatal(err)
	}
	if err := d.SetTheme("invalid"); err == nil {
		t.Fatal("invalid theme accepted")
	}
	p, err = Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got, err := p.Theme(); err != nil || got != "dark" {
		t.Fatalf("production theme = %q (%v)", got, err)
	}
	if _, err := Open(prod, Development); err == nil {
		t.Fatal("cross-profile path accepted")
	}
}

func TestRejectForeignDatabase(t *testing.T) {
	paths, _ := ResolveAt(t.TempDir(), Development)
	if err := os.MkdirAll(paths.Root, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE agent_history(id INTEGER); INSERT INTO agent_history VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, err := os.ReadFile(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(paths, Development); err == nil {
		t.Fatal("foreign DB accepted")
	}
	after, err := os.ReadFile(paths.Database)
	if err != nil || string(before) != string(after) {
		t.Fatal("foreign DB modified")
	}
}

func TestRejectOtherProfileDatabaseCopy(t *testing.T) {
	base := t.TempDir()
	prod, _ := ResolveAt(base, Production)
	dev, _ := ResolveAt(base, Development)
	p, err := Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
	content, err := os.ReadFile(prod.Database)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dev.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dev.Database, content, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dev, Development); err == nil {
		t.Fatal("copied production database accepted")
	}
}

func TestRejectInvalidProfile(t *testing.T) {
	if _, err := ResolveAt(t.TempDir(), "other"); err == nil {
		t.Fatal("invalid profile accepted")
	}
	if _, err := ResolveAt(filepath.Join("relative"), Development); err == nil {
		t.Fatal("relative directory accepted")
	}
}

func TestLanguagePreferenceCompatibilityAndIsolation(t *testing.T) {
	base := t.TempDir()
	prod, _ := ResolveAt(base, Production)
	dev, _ := ResolveAt(base, Development)
	p, err := Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := p.Language(); err != nil || got != "system" {
		t.Fatalf("existing schema default: %q, %v", got, err)
	}
	if err := p.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if err := p.SetLanguage("zh-CN"); err != nil {
		t.Fatal(err)
	}
	if err := p.SetLanguage("en-US"); err != nil {
		t.Fatal(err)
	}
	if err := p.SetLanguage("ja-JP"); err == nil {
		t.Fatal("invalid language accepted")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}

	d, err := Open(dev, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if got, err := d.Language(); err != nil || got != "system" {
		t.Fatalf("dev language: %q, %v", got, err)
	}
	if err := d.SetLanguage("zh-CN"); err != nil {
		t.Fatal(err)
	}

	p, err = Open(prod, Production)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got, err := p.Language(); err != nil || got != "en-US" {
		t.Fatalf("persisted language: %q, %v", got, err)
	}
	if got, err := p.Theme(); err != nil || got != "dark" {
		t.Fatalf("theme changed: %q, %v", got, err)
	}
	var schema int
	if err := p.db.QueryRow("PRAGMA user_version").Scan(&schema); err != nil || schema != schemaVersion {
		t.Fatalf("schema changed: %d, %v", schema, err)
	}
	if _, err := p.db.Exec("UPDATE settings SET value='bad' WHERE key='language'"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Language(); err == nil {
		t.Fatal("invalid stored language accepted")
	}
}
