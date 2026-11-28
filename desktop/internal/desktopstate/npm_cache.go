package desktopstate

import (
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

type npmCacheValue struct {
	Version    string    `json:"version"`
	ObservedAt time.Time `json:"observedAt"`
}

func validNPMCacheKey(key string) bool {
	if len(key) != 64 {
		return false
	}
	_, err := hex.DecodeString(key)
	return err == nil
}

// These are public registry observations only. The setting key is a digest of
// package and dist-tag; no Agent credentials, paths or private registry data
// are stored in the Desktop database.
func (s *Store) LoadPublicNPMVersion(key string) (string, time.Time, bool, error) {
	if !validNPMCacheKey(key) {
		return "", time.Time{}, false, errors.New("invalid_npm_cache_key")
	}
	var raw string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key = ?", "npm-cache:"+key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, err
	}
	var value npmCacheValue
	if len(raw) > 512 || json.Unmarshal([]byte(raw), &value) != nil || value.Version == "" || len(value.Version) > 256 || value.ObservedAt.IsZero() {
		return "", time.Time{}, false, errors.New("invalid_npm_cache")
	}
	return value.Version, value.ObservedAt, true, nil
}

func (s *Store) SavePublicNPMVersion(key, version string, observedAt time.Time) error {
	if !validNPMCacheKey(key) || version == "" || len(version) > 256 || observedAt.IsZero() {
		return errors.New("invalid_npm_cache")
	}
	body, err := json.Marshal(npmCacheValue{Version: version, ObservedAt: observedAt.UTC()})
	if err != nil {
		return err
	}
	_, err = s.db.Exec("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "npm-cache:"+key, string(body))
	return err
}
