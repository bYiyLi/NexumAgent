package desktopstate

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Only actual schema changes enter this sequence. Production currently
// supports v2; subsequent versions must add a contiguous embedded script.
var migrations = map[int]string{}

func init() {
	for version := 2; version <= schemaVersion; version++ {
		data, err := migrationFiles.ReadFile(fmt.Sprintf("migrations/%03d.sql", version))
		if err != nil {
			panic("missing compiled desktop migration")
		}
		migrations[version] = string(data)
	}
}

type queryer interface{ QueryRow(string, ...any) *sql.Row }

func readIdentity(q queryer, profile Profile, target int) (int, error) {
	var id, n int
	if err := q.QueryRow("PRAGMA application_id").Scan(&id); err != nil {
		return 0, err
	}
	if err := q.QueryRow("PRAGMA user_version").Scan(&n); err != nil {
		return 0, err
	}
	if id != profile.applicationID() || n < 1 {
		return 0, ErrInvalidDatabase
	}
	if n > target {
		return 0, ErrIncompatible
	}
	var stored string
	if err := q.QueryRow("SELECT value FROM settings WHERE key='profile'").Scan(&stored); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrInvalidDatabase, err)
	}
	if stored != string(profile) {
		return 0, ErrInvalidDatabase
	}
	return n, nil
}

func initializeFresh(db *sql.DB, profile Profile, target int, steps map[int]string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	initial, err := migrationFiles.ReadFile("migrations/001.sql")
	if err != nil {
		return err
	}
	if _, err = tx.Exec(fmt.Sprintf("PRAGMA application_id = %d", profile.applicationID())); err != nil {
		return err
	}
	if _, err = tx.Exec(string(initial)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO settings(key,value) VALUES ('profile',?),('theme','system')", string(profile)); err != nil {
		return err
	}
	if err = applyMigrations(tx, 1, target, steps); err != nil {
		return err
	}
	if _, err = readIdentity(tx, profile, target); err != nil {
		return err
	}
	return tx.Commit()
}

func applyMigrations(tx *sql.Tx, from, target int, steps map[int]string) error {
	for n := from + 1; n <= target; n++ {
		script, ok := steps[n]
		if !ok || script == "" {
			return fmt.Errorf("missing migration to schema %d", n)
		}
		if _, err := tx.Exec(script); err != nil {
			return fmt.Errorf("schema %d: %w", n, err)
		}
	}
	_, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", target))
	return err
}
func integrity(q queryer) error {
	var result string
	if err := q.QueryRow("PRAGMA quick_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("SQLite quick_check failed: %s", result)
	}
	return nil
}
func migrateDatabase(db *sql.DB, profile Profile, from, target int, steps map[int]string, progress func(string)) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	n, err := readIdentity(tx, profile, target)
	if err != nil {
		return err
	}
	if n != from {
		return fmt.Errorf("database changed during preparation")
	}
	if err = applyMigrations(tx, from, target, steps); err != nil {
		return err
	}
	report(progress, "dataVerifying")
	if n, err = readIdentity(tx, profile, target); err != nil || n != target {
		return fmt.Errorf("migration identity verification: %v", err)
	}
	if err = integrity(tx); err != nil {
		return err
	}
	rows, err := tx.Query("PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	violations := rows.Next()
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return rowErr
	}
	if violations {
		return fmt.Errorf("migrated database has foreign key violations")
	}
	var theme string
	if err = tx.QueryRow("SELECT value FROM settings WHERE key='theme'").Scan(&theme); err != nil {
		return err
	}
	if theme != "system" && theme != "light" && theme != "dark" {
		return fmt.Errorf("invalid migrated theme")
	}
	rows, err = tx.Query("SELECT key,value FROM settings WHERE key IN ('language','hideOnClose','desktopNotifications','errorNotifications','resultNotifications')")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err = rows.Scan(&key, &value); err != nil {
			return err
		}
		if key == "language" {
			if !validLanguage(value) {
				return fmt.Errorf("invalid migrated language")
			}
		} else if value != "true" && value != "false" {
			return fmt.Errorf("invalid migrated preference %s", key)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	return tx.Commit()
}

// VACUUM INTO is a consistent SQLite snapshot, including committed WAL
// content. Never copy a potentially live SQLite file with os.ReadFile.
func backupDatabase(db *sql.DB, paths Paths, profile Profile, version int) (string, error) {
	root := filepath.Join(paths.Root, "backups")
	if err := ensureDirectory(root); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(root, fmt.Sprintf("schema-%d-", version))
	if err != nil {
		return "", err
	}
	dst := filepath.Join(dir, "desktop.sqlite")
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dir)
		}
	}()
	if _, err = db.Exec("VACUUM INTO ?", dst); err != nil {
		return "", err
	}
	if err = os.Chmod(dst, 0600); err != nil {
		return "", err
	}
	copy, err := openDB(dst)
	if err != nil {
		return "", err
	}
	n, e := readIdentity(copy, profile, version)
	if e == nil && n != version {
		e = fmt.Errorf("backup schema mismatch")
	}
	if e == nil {
		e = integrity(copy)
	}
	closeErr := copy.Close()
	if e != nil {
		return "", e
	}
	if closeErr != nil {
		return "", closeErr
	}
	f, err := os.OpenFile(dst, os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	err = f.Sync()
	closeErr = f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	ok = true
	return dst, nil
}
