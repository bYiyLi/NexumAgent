package desktopstate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Preferences are Desktop-owned choices. OS login registration and OS
// notification authorization are observed separately, never mirrored as truth.
type Preferences struct {
	HideOnClose          bool `json:"hideOnClose"`
	DesktopNotifications bool `json:"desktopNotifications"`
	ErrorNotifications   bool `json:"errorNotifications"`
	ResultNotifications  bool `json:"resultNotifications"`
}

func defaultPreferences() Preferences {
	return Preferences{HideOnClose: true, ErrorNotifications: true, ResultNotifications: true}
}

func (p *Preferences) set(key string, value bool) error {
	switch key {
	case "hideOnClose":
		p.HideOnClose = value
	case "desktopNotifications":
		p.DesktopNotifications = value
	case "errorNotifications":
		p.ErrorNotifications = value
	case "resultNotifications":
		p.ResultNotifications = value
	default:
		return errors.New("unknown desktop preference")
	}
	return nil
}

func (s *Store) Preferences() (Preferences, error) {
	p := defaultPreferences()
	rows, err := s.db.Query("SELECT key, value FROM settings WHERE key IN ('hideOnClose', 'desktopNotifications', 'errorNotifications', 'resultNotifications')")
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return p, err
		}
		if value != "true" && value != "false" {
			return p, fmt.Errorf("invalid stored desktop preference %s", key)
		}
		if err := p.set(key, value == "true"); err != nil {
			return p, err
		}
	}
	return p, rows.Err()
}

func (s *Store) SetPreference(key string, value bool) error {
	p := defaultPreferences()
	if err := p.set(key, value); err != nil {
		return err
	}
	_, err := s.db.Exec("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, strconv.FormatBool(value))
	return err
}

// DiagnosticDirectory never accepts a filesystem path from the WebView.
func DiagnosticDirectory(paths Paths, profile Profile, kind string) (string, error) {
	expected, err := ResolveAt(filepath.Dir(paths.Root), profile)
	if err != nil || expected != paths {
		return "", errors.New("desktop path/profile mismatch")
	}
	if err := checkDirectory(paths.Root); err != nil {
		return "", err
	}
	switch kind {
	case "data":
		return paths.Root, nil
	case "logs":
		if err := checkDirectory(paths.Logs); err != nil {
			return "", err
		}
		return paths.Logs, nil
	default:
		return "", errors.New("unknown desktop diagnostic directory")
	}
}

func checkDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe desktop diagnostic directory")
	}
	return nil
}
