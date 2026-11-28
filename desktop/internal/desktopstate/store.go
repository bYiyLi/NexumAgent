package desktopstate

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const schemaVersion = 2

var (
	ErrIncompatible    = errors.New("desktop database schema is newer than this client")
	ErrInvalidDatabase = errors.New("unrecognized desktop database or profile")
	ErrMigration       = errors.New("desktop database migration failed")
)

// Progress callbacks report actual work, not a percentage. Nil is supported.
func report(progress func(string), phase string) {
	if progress != nil {
		progress(phase)
	}
}

type Store struct{ db *sql.DB }

func ensureDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe desktop directory: %s", filepath.Base(path))
	}
	return nil
}

// prepare validates the profile before creating its own directories.
func prepare(paths Paths, profile Profile) error {
	expected, err := ResolveAt(filepath.Dir(paths.Root), profile)
	if err != nil {
		return err
	}
	if expected != paths {
		return errors.New("desktop path/profile mismatch")
	}
	for _, dir := range []string{paths.Root, paths.Logs, paths.WebView} {
		if err := ensureDirectory(dir); err != nil {
			return err
		}
	}
	return nil
}

// OpenLog opens a profile-owned log, not a path supplied by the frontend.
func PreparePaths(paths Paths, profile Profile) error { return prepare(paths, profile) }

func OpenLog(paths Paths, profile Profile) (*os.File, error) {
	if err := prepare(paths, profile); err != nil {
		return nil, err
	}
	name := filepath.Join(paths.Logs, "desktop.log")
	info, err := os.Lstat(name)
	if err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return nil, errors.New("unsafe desktop log path")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
}

// Open opens only the desktop database resolved from a known profile. It
// rejects unknown or other-profile databases before applying schema changes.
func Open(paths Paths, profile Profile) (*Store, error) {
	return OpenWithProgress(paths, profile, nil)
}
func OpenWithProgress(paths Paths, profile Profile, progress func(string)) (*Store, error) {
	return openSchema(paths, profile, schemaVersion, migrations, progress)
}
func openSchema(paths Paths, profile Profile, target int, steps map[int]string, progress func(string)) (*Store, error) {
	if err := prepare(paths, profile); err != nil {
		return nil, err
	}
	if err := validateDatabaseFiles(paths.Database); err != nil {
		return nil, err
	}
	_, err := os.Lstat(paths.Database)
	if errors.Is(err, os.ErrNotExist) {
		// Create and initialize off-path. A crash cannot leave a zero-byte
		// "existing" database. Link refuses an unexpected competing destination.
		dir, err := os.MkdirTemp(paths.Root, ".database-create-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(dir)
		path := filepath.Join(dir, "desktop.sqlite")
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
		db, err := openDB(path)
		if err != nil {
			return nil, err
		}
		err = initializeFresh(db, profile, target, steps)
		closeErr := db.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if err = os.Link(path, paths.Database); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	db, err := openDB(paths.Database)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = db.Close()
		}
	}()
	n, err := readIdentity(db, profile, target)
	if err != nil {
		return nil, err
	}
	if n < target {
		report(progress, "backup")
		if _, err = backupDatabase(db, paths, profile, n); err != nil {
			return nil, fmt.Errorf("%w: backup: %v", ErrMigration, err)
		}
		report(progress, "migration")
		if err = migrateDatabase(db, profile, n, target, steps, progress); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrMigration, err)
		}
	}
	ok = true
	return &Store{db: db}, nil
}
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON"); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
func validateDatabaseFiles(path string) error {
	for _, suffix := range []string{"", "-journal", "-wal", "-shm"} {
		info, err := os.Lstat(path + suffix)
		if err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
			return errors.New("unsafe desktop database path")
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *Store) Theme() (string, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key = 'theme'").Scan(&value)
	return value, err
}

func (s *Store) SetTheme(value string) error {
	switch value {
	case "system", "light", "dark":
	default:
		return errors.New("invalid desktop theme")
	}
	_, err := s.db.Exec("UPDATE settings SET value = ? WHERE key = 'theme'", value)
	return err
}

// Language is an optional setting in the existing version-1 key/value schema.
// Old databases have no language row and remain compatible in either direction.
func (s *Store) Language() (string, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key = 'language'").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "system", nil
	}
	if err != nil {
		return "", err
	}
	if !validLanguage(value) {
		return "", errors.New("invalid stored desktop language")
	}
	return value, nil
}

func validLanguage(value string) bool {
	return value == "system" || value == "zh-CN" || value == "en-US"
}

func (s *Store) SetLanguage(value string) error {
	if !validLanguage(value) {
		return errors.New("invalid desktop language")
	}
	_, err := s.db.Exec("INSERT INTO settings(key, value) VALUES ('language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", value)
	return err
}

func (s *Store) Close() error { return s.db.Close() }
