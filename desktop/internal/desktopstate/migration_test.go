package desktopstate

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMigrationChainAndConsistentBackup(t *testing.T) {
	p, _ := ResolveAt(t.TempDir(), Development)
	s, err := openSchema(p, Development, 1, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetLanguage("zh-CN"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	var phases []string
	s, err = openSchema(p, Development, 3, map[int]string{2: "CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample VALUES(7)", 3: "ALTER TABLE sample ADD COLUMN label TEXT DEFAULT 'kept'"}, func(p string) { phases = append(phases, p) })
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(phases, []string{"backup", "migration", "dataVerifying"}) {
		t.Fatal(phases)
	}
	if v, e := s.Theme(); e != nil || v != "dark" {
		t.Fatal(v, e)
	}
	var n int
	if err = s.db.QueryRow("SELECT id FROM sample WHERE label='kept'").Scan(&n); err != nil || n != 7 {
		t.Fatal(n, err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(p, Development); !errors.Is(err, ErrIncompatible) {
		t.Fatalf("downgrade: %v", err)
	}
	backups, err := filepath.Glob(filepath.Join(p.Root, "backups", "schema-*", "desktop.sqlite"))
	if err != nil || len(backups) != 1 {
		t.Fatal(backups, err)
	}
	db, err := openDB(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if n, err = readIdentity(db, Development, 1); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	var theme string
	if err = db.QueryRow("SELECT value FROM settings WHERE key='theme'").Scan(&theme); err != nil || theme != "dark" {
		t.Fatal(theme, err)
	}
}
func TestMigrationFailureRollsBackAllSteps(t *testing.T) {
	p, _ := ResolveAt(t.TempDir(), Production)
	s, err := openSchema(p, Production, 1, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	_, err = openSchema(p, Production, 3, map[int]string{2: "CREATE TABLE sample(id INTEGER); UPDATE settings SET value='light' WHERE key='theme'", 3: "INVALID SQL"}, nil)
	if !errors.Is(err, ErrMigration) {
		t.Fatal(err)
	}
	s, err = Open(p, Production)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, err := s.Theme(); err != nil || v != "dark" {
		t.Fatal(v, err)
	}
	var n int
	if err = s.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='sample'").Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
func TestFreshSchemaAndUnknownDatabasePreservation(t *testing.T) {
	p, _ := ResolveAt(t.TempDir(), Development)
	if _, err := openSchema(p, Development, 2, map[int]string{}, nil); err == nil {
		t.Fatal("missing migration accepted")
	}
	if _, err := os.Stat(p.Database); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed creation left database", err)
	}
	s, err := Open(p, Development)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}
