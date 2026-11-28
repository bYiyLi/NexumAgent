package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

type Config struct {
	Root    string
	Profile string
	Version string
	Key     ed25519.PublicKey
	// Source builds without a configured distribution key never download.
	// Distribution CI requires a key for both release channels.
	Enabled bool
}
type State struct {
	Format        int            `json:"format"`
	Required      SignedManifest `json:"required"`
	Phase         string         `json:"phase"`
	Transaction   string         `json:"transaction,omitempty"`
	SourceVersion string         `json:"sourceVersion,omitempty"`
	SourceBinary  string         `json:"sourceBinary,omitempty"`
	SourceSHA256  string         `json:"sourceSha256,omitempty"`
	ParentPID     int            `json:"parentPid,omitempty"`
	Error         string         `json:"error,omitempty"`
}

var transactionPattern = regexp.MustCompile("^[0-9a-f]{32}$")

func (c Config) check() error {
	if c.Profile != "production" && c.Profile != "development" {
		return fmt.Errorf("invalid update profile")
	}
	if !filepath.IsAbs(c.Root) {
		return fmt.Errorf("invalid update root")
	}
	expected := "NexumDesktop"
	if c.Profile == "development" {
		expected = "NexumDesktopDev"
	}
	if filepath.Base(c.Root) != expected {
		return fmt.Errorf("update profile path mismatch")
	}
	if c.Enabled && len(c.Key) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: missing distribution key", ErrTrust)
	}
	return nil
}
func (c Config) dir() string { return filepath.Join(c.Root, "updates") }
func safeDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	f, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !f.IsDir() || f.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe update directory")
	}
	return nil
}
func (c Config) Prepare() error {
	if err := c.check(); err != nil {
		return err
	}
	for _, p := range []string{c.Root, c.dir(), filepath.Join(c.dir(), "downloads"), filepath.Join(c.dir(), "staging")} {
		if err := safeDir(p); err != nil {
			return err
		}
	}
	return nil
}
func safeRead(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > max {
		return nil, fmt.Errorf("unsafe or oversized update state")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if int64(len(b)) > max {
		return nil, fmt.Errorf("update state exceeds limit")
	}
	return b, err
}
func (c Config) Load() (*State, error) {
	if err := c.Prepare(); err != nil {
		return nil, err
	}
	data, err := safeRead(filepath.Join(c.dir(), "state.json"), 1024*1024)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err = strictJSON(data, &s); err != nil {
		return nil, fmt.Errorf("%w: state format: %v", ErrRecovery, err)
	}
	if _, err = c.validate(s); err != nil {
		return nil, err
	}
	return &s, nil
}
func (c Config) validate(s State) (Manifest, error) {
	m, e := s.Required.Verify(c.Key, c.Profile)
	if e != nil {
		return m, e
	}
	if s.Format != 1 {
		return m, fmt.Errorf("%w: unsupported state", ErrRecovery)
	}
	switch s.Phase {
	case "required":
		if s.Transaction != "" || s.SourceBinary != "" || s.ParentPID != 0 {
			return m, fmt.Errorf("%w: unexpected install transaction", ErrRecovery)
		}
	case "handoff", "installing", "installed", "interrupted", "permission", "installFailed", "complete":
		if !transactionPattern.MatchString(s.Transaction) || !validChannel(s.SourceVersion, c.Profile) || !filepath.IsAbs(s.SourceBinary) || !hashOK(s.SourceSHA256) || s.ParentPID <= 0 {
			return m, fmt.Errorf("%w: invalid installation transaction", ErrRecovery)
		}
		cmp, err := CompareVersions(m.Version, s.SourceVersion)
		if err != nil || cmp <= 0 {
			return m, fmt.Errorf("%w: invalid transaction version", ErrRecovery)
		}
	default:
		return m, fmt.Errorf("%w: unknown update phase", ErrRecovery)
	}
	return m, nil
}
func (c Config) Save(s State) error {
	if err := c.Prepare(); err != nil {
		return err
	}
	if _, err := c.validate(s); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(c.dir(), "state.json"), b)
}
func writeAtomic(path string, data []byte) error {
	if st, e := os.Lstat(path); e == nil && (!st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0) {
		return fmt.Errorf("unsafe update state destination")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".update-write-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return replaceFile(f.Name(), path)
}
func nonce() (string, error) {
	var b [16]byte
	_, e := rand.Read(b[:])
	return hex.EncodeToString(b[:]), e
}
func fileDigest(path string) (string, int64, error) {
	i, e := os.Lstat(path)
	if e != nil {
		return "", 0, e
	}
	if !i.Mode().IsRegular() || i.Mode()&os.ModeSymlink != 0 {
		return "", 0, fmt.Errorf("unsafe update file")
	}
	f, e := os.Open(path)
	if e != nil {
		return "", 0, e
	}
	defer f.Close()
	h := sha256.New()
	n, e := io.Copy(h, f)
	if e != nil {
		return "", 0, e
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
func (c Config) ArtifactPath(a Artifact) string { return filepath.Join(c.dir(), "downloads", a.Name) }
func (c Config) jobDir(s State) string          { return filepath.Join(c.dir(), "staging", s.Transaction) }
func (c Config) helperPath(s State) string {
	n := "helper"
	if runtime.GOOS == "windows" {
		n += ".exe"
	}
	return filepath.Join(c.jobDir(s), n)
}
func (c Config) Manifest(s State) (Manifest, error) { return c.validate(s) }
func (c Config) Require(s SignedManifest) (*State, error) {
	m, e := s.Verify(c.Key, c.Profile)
	if e != nil {
		return nil, e
	}
	cmp, e := CompareVersions(m.Version, c.Version)
	if e != nil || cmp <= 0 {
		return nil, fmt.Errorf("%w: downgrade or same version", ErrTrust)
	}
	old, e := c.Load()
	if e != nil {
		return nil, e
	}
	if old != nil {
		om, e := c.validate(*old)
		if e != nil {
			return nil, e
		}
		v, e := CompareVersions(m.Version, om.Version)
		if e != nil || v < 0 {
			return nil, fmt.Errorf("%w: release rollback", ErrTrust)
		}
		if v == 0 {
			return old, nil
		}
		if old.Phase != "required" && old.Phase != "complete" && old.Phase != "interrupted" {
			return nil, fmt.Errorf("%w: existing install not reconciled", ErrRecovery)
		}
	}
	state := State{Format: 1, Required: s, Phase: "required"}
	if e = c.Save(state); e != nil {
		return nil, e
	}
	return &state, nil
}
func (c Config) MarkComplete(s *State) error {
	if s == nil {
		return nil
	}
	m, e := c.validate(*s)
	if e != nil {
		return e
	}
	cmp, e := CompareVersions(c.Version, m.Version)
	if e != nil || cmp < 0 {
		return fmt.Errorf("%w: update not installed", ErrRecovery)
	}
	// Preserve the signed highest required version even after success, so a
	// manually restored older client cannot bypass the known update.
	if s.Phase == "complete" || s.Phase == "required" {
		return nil
	}
	if s.Phase != "installed" {
		return fmt.Errorf("%w: installation not reconciled", ErrRecovery)
	}
	s.Phase = "complete"
	s.Error = ""
	return c.Save(*s)
}
