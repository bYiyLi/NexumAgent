package updater

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// Lock serializes a startup reconciliation and a detached installer even
// across process crashes. A second app may start while a helper still runs,
// but it must not access mutable update/database state until the lock is free.
func (c Config) Lock() (func(), error) {
	if err := c.Prepare(); err != nil {
		return nil, err
	}
	path := filepath.Join(c.dir(), "install.lock")
	if st, e := os.Lstat(path); e == nil && (!st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("unsafe update lock")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	f, e := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if e != nil {
		return nil, e
	}
	if e = lockFile(f); e != nil {
		f.Close()
		return nil, fmt.Errorf("%w: another update transaction may still be running: %v", ErrRecovery, e)
	}
	return func() { unlockFile(f); _ = f.Close() }, nil
}
func copyFile(from, to string, mode os.FileMode) error {
	st, e := os.Lstat(from)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe source file")
	}
	in, e := os.Open(from)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	if e == nil {
		e = out.Sync()
	}
	closeErr := out.Close()
	if e != nil {
		return e
	}
	return closeErr
}
func currentBinary() (string, error) {
	p, e := os.Executable()
	if e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(p)
}

// Reconcile is called under Lock by a freshly started Desktop. The binary
// hash, not a stale installer exit code, determines an observed installation.
// Unknown Windows partial effects never trigger a silent replay.
func (c Config) Reconcile(s *State) (*State, error) {
	if s == nil {
		return nil, nil
	}
	m, e := c.validate(*s)
	if e != nil {
		return nil, e
	}
	cmp, e := CompareVersions(c.Version, m.Version)
	if e != nil {
		return nil, e
	}
	if s.Phase == "required" && cmp < 0 {
		return s, nil
	}
	binary, e := currentBinary()
	if e != nil {
		return nil, e
	}
	a, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return nil, e
	}
	digest, _, e := fileDigest(binary)
	if e != nil {
		return nil, e
	}
	if cmp >= 0 {
		// A later version installed manually is allowed to satisfy the older
		// signed requirement. For the exact target require its signed binary hash.
		if cmp == 0 && digest != a.BinarySHA256 {
			return nil, fmt.Errorf("%w: installed binary differs from signed release", ErrTrust)
		}
		if s.Phase == "required" || s.Phase == "complete" {
			return s, nil
		}
		s.Phase = "installed"
		s.Error = ""
		if e = c.Save(*s); e != nil {
			return nil, e
		}
		return s, nil
	}
	if s.Phase == "complete" {
		// An old version was restored after a successful upgrade. Retain the
		// signed requirement and prepare a new attempt without deleting data.
		next := State{Format: 1, Required: s.Required, Phase: "required"}
		if e = c.Save(next); e != nil {
			return nil, e
		}
		return &next, nil
	}
	if s.Phase == "handoff" || s.Phase == "installing" || s.Phase == "installed" {
		if binary != s.SourceBinary || digest != s.SourceSHA256 {
			return nil, fmt.Errorf("%w: executable changed during interrupted install", ErrRecovery)
		}
		if runtime.GOOS == "windows" && s.Phase != "handoff" {
			s.Phase = "installFailed"
			s.Error = "installation outcome unknown"
		} else {
			// macOS uses an atomic exchange. If the old signed binary is still in
			// place, no exchange occurred (or it was restored).
			s.Phase = "interrupted"
			s.Error = "installation interrupted"
		}
		if e = c.Save(*s); e != nil {
			return nil, e
		}
	}
	return s, nil
}

// StartHelper is called only after signed package verification. The caller
// must have released the reconciliation lock and still own the Wails single
// instance. It may quit only after the helper holds the OS lock and is
// waiting on the exact parent process.
func (c Config) StartHelper(ctx context.Context, s State, a Artifact) (State, error) {
	m, e := c.validate(s)
	if e != nil {
		return s, e
	}
	cmp, e := CompareVersions(m.Version, c.Version)
	if e != nil || cmp <= 0 {
		return s, fmt.Errorf("%w: no newer version", ErrTrust)
	}
	if s.Phase != "required" && s.Phase != "interrupted" {
		return s, fmt.Errorf("%w: installation state must be reconciled before handoff", ErrRecovery)
	}
	binary, e := currentBinary()
	if e != nil {
		return s, e
	}
	if e = validateInstallTarget(c, binary); e != nil {
		return s, e
	}
	selected, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
	if e != nil || selected != a {
		return s, fmt.Errorf("%w: mismatched platform artifact", ErrTrust)
	}
	if e = verifyFile(c.ArtifactPath(a), a); e != nil {
		return s, e
	}
	if e = verifyPackage(c, binary, c.ArtifactPath(a), a); e != nil {
		return s, e
	}
	sha, _, e := fileDigest(binary)
	if e != nil {
		return s, e
	}
	id, e := nonce()
	if e != nil {
		return s, e
	}
	s.Phase = "handoff"
	s.Transaction = id
	s.SourceVersion = c.Version
	s.SourceBinary = binary
	s.SourceSHA256 = sha
	s.ParentPID = os.Getpid()
	s.Error = ""
	job := c.jobDir(s)
	if e = os.Mkdir(job, 0700); e != nil {
		return s, e
	}
	helper := c.helperPath(s)
	if e = copyFile(binary, helper, 0700); e != nil {
		return s, e
	}
	if e = c.Save(s); e != nil {
		return s, e
	}
	log, e := os.OpenFile(filepath.Join(job, "install.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return s, e
	}
	defer log.Close()
	cmd := exec.Command(helper, "--desktop-update-helper", id)
	cmd.Dir = job
	cmd.Stdout = log
	cmd.Stderr = log
	detach(cmd)
	if e = cmd.Start(); e != nil {
		// A failed Start has no live helper.
		s.Phase = "interrupted"
		s.Error = "could not start update helper"
		_ = c.Save(s)
		return s, e
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timeout := time.NewTimer(150 * time.Second)
	defer timeout.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	ack := filepath.Join(job, "waiting")
	for {
		select {
		case e = <-done:
			return s, fmt.Errorf("%w: helper exited before handoff: %v", ErrRecovery, e)
		case <-ctx.Done():
			return s, fmt.Errorf("%w: handoff cancelled", ErrRecovery)
		case <-timeout.C:
			return s, fmt.Errorf("%w: helper handoff not confirmed", ErrRecovery)
		case <-tick.C:
			b, e := safeRead(ack, 64)
			if e == nil && string(b) == id {
				return s, nil
			}
		}
	}
}

// RunHelper must be dispatched before any Wails/SQLite initialization.
// The transaction has no arbitrary URL, command or caller-supplied target.
func (c Config) RunHelper(id string) error {
	if !c.Enabled || !transactionPattern.MatchString(id) {
		return fmt.Errorf("invalid helper invocation")
	}
	release, e := c.Lock()
	if e != nil {
		return e
	}
	locked := true
	defer func() {
		if locked {
			release()
		}
	}()
	s, e := c.Load()
	if e != nil {
		return e
	}
	if s == nil || s.Phase != "handoff" || s.Transaction != id || s.SourceVersion != c.Version {
		return fmt.Errorf("%w: no matching handoff", ErrRecovery)
	}
	actual, e := currentBinary()
	if e != nil {
		return e
	}
	expectedHelper, e := filepath.EvalSymlinks(c.helperPath(*s))
	if e != nil || actual != expectedHelper {
		return fmt.Errorf("unexpected helper location")
	}
	digest, _, e := fileDigest(actual)
	if e != nil || digest != s.SourceSHA256 {
		return fmt.Errorf("%w: helper identity", ErrTrust)
	}
	m, e := c.validate(*s)
	if e != nil {
		return e
	}
	cmp, e := CompareVersions(m.Version, c.Version)
	if e != nil || cmp <= 0 {
		return fmt.Errorf("%w: invalid target version", ErrTrust)
	}
	a, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return e
	}
	path := c.ArtifactPath(a)
	if e = validateInstallTarget(c, s.SourceBinary); e != nil {
		return e
	}
	sha, _, e := fileDigest(s.SourceBinary)
	if e != nil || sha != s.SourceSHA256 {
		return fmt.Errorf("%w: source binary changed", ErrTrust)
	}
	if e = verifyFile(path, a); e != nil {
		return e
	}
	if e = verifyPackage(c, s.SourceBinary, path, a); e != nil {
		return e
	}
	fmt.Println("verified update helper, waiting for Desktop exit", s.Transaction)
	if e = waitParent(s.ParentPID, func() error { return writeAtomic(filepath.Join(c.jobDir(*s), "waiting"), []byte(id)) }); e != nil {
		s.Phase = "interrupted"
		s.Error = "old client did not exit"
		_ = c.Save(*s)
		return e
	}
	// Re-read after parent exit. No stale action is allowed to install.
	again, e := c.Load()
	if e != nil || again == nil || again.Transaction != id || again.Phase != "handoff" {
		return fmt.Errorf("%w: handoff changed", ErrRecovery)
	}
	if e = verifyFile(path, a); e != nil {
		return e
	}
	s.Phase = "installing"
	if e = c.Save(*s); e != nil {
		return e
	}
	fmt.Println("old Desktop exited; installing verified release", m.Version)
	e = installPackage(c, *s, a, path)
	if e == nil {
		hash, _, readErr := fileDigest(s.SourceBinary)
		if readErr != nil || hash != a.BinarySHA256 {
			e = fmt.Errorf("%w: installed executable not verified", ErrRecovery)
		}
	}
	if e != nil {
		s.Error = e.Error()
		if errors.Is(e, ErrPermission) {
			s.Phase = "permission"
		} else {
			s.Phase = "installFailed"
		}
		saveErr := c.Save(*s)
		if saveErr != nil {
			return errors.Join(e, saveErr)
		}
		// Only restart a provably unchanged old program. It will remain gated.
		hash, _, readErr := fileDigest(s.SourceBinary)
		release()
		locked = false
		if readErr == nil && hash == s.SourceSHA256 {
			_ = launchInstalled(c, s.SourceBinary)
		}
		return e
	}
	fmt.Println("installed executable hash verified", m.Version)
	s.Phase = "installed"
	s.Error = ""
	if e = c.Save(*s); e != nil {
		return e
	}
	release()
	locked = false
	return launchInstalled(c, s.SourceBinary)
}

func (c Config) OpenManualPackage(s State, a Artifact) error {
	if _, e := c.validate(s); e != nil {
		return e
	}
	// Only reveal the exact verified package in the OS file manager. Never
	// execute a second installer blindly after an uncertain installation.
	if e := verifyFile(c.ArtifactPath(a), a); e != nil {
		return e
	}
	return revealPackage(c.ArtifactPath(a))
}
