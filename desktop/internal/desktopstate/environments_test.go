package desktopstate

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestRealEnvironmentMigrationAndTrust(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	paths, _ := ResolveAt(base, Development)
	old, err := openSchema(paths, Development, 1, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = old.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if err = old.SetLanguage("zh-CN"); err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(paths, Development)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if n, e := readIdentity(s.db, Development, 2); e != nil || n != 2 {
		t.Fatal(n, e)
	}
	if v, e := s.Theme(); e != nil || v != "dark" {
		t.Fatal(v, e)
	}
	if v, e := s.Language(); e != nil || v != "zh-CN" {
		t.Fatal(v, e)
	}
	backups, e := filepath.Glob(filepath.Join(paths.Root, "backups", "schema-*", "desktop.sqlite"))
	if e != nil || len(backups) != 1 {
		t.Fatal(backups, e)
	}
	r := EnvironmentRecord{ID: "test", Host: "example.test", Port: 22, Username: "tester", AuthType: "agent", Hostname: "fixture", Platform: "linux", Arch: "amd64"}
	key := HostKey{Type: "ssh-ed25519", Fingerprint: "SHA256:fixture"}
	if e = s.SaveEnvironment(ctx, r, key); e != nil {
		t.Fatal(e)
	}
	got, e := s.FindEnvironment(ctx, r.Host, r.Port, r.Username)
	if e != nil || got.ID != r.ID || got.CredentialRef != "" {
		t.Fatal(got, e)
	}
	if e = s.SaveEnvironment(ctx, r, HostKey{Type: key.Type, Fingerprint: "SHA256:changed"}); !errors.Is(e, ErrHostKeyChanged) {
		t.Fatal(e)
	}
	other := r
	other.ID = "duplicate"
	if e = s.SaveEnvironment(ctx, other, key); e == nil {
		t.Fatal("duplicate accepted")
	}
	prodPaths, _ := ResolveAt(base, Production)
	prod, e := Open(prodPaths, Production)
	if e != nil {
		t.Fatal(e)
	}
	defer prod.Close()
	if rows, e := prod.Environments(ctx); e != nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
	if e = s.RemoveEnvironment(ctx, r.ID); e != nil {
		t.Fatal(e)
	}
	if rows, e := s.Environments(ctx); e != nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
	if pin, e := s.TrustedHost(ctx, r.Host, r.Port); e != nil || pin != key {
		t.Fatal(pin, e)
	}
}
