package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/bYiyLi/NexumAgent/desktop/internal/updater"
)

// Distribution builds inject the channel's public key through ldflags.
// Local source/candidate builds are explicitly not a release channel.
var updatePublicKey string
var distributionBuild = "false"

type BootstrapSnapshot struct {
	Revision         uint64      `json:"revision"`
	Phase            string      `json:"phase"`
	Info             DesktopInfo `json:"info"`
	CurrentVersion   string      `json:"currentVersion"`
	TargetVersion    string      `json:"targetVersion"`
	DownloadedBytes  int64       `json:"downloadedBytes"`
	TotalBytes       int64       `json:"totalBytes"`
	ErrorCode        string      `json:"errorCode"`
	Retryable        bool        `json:"retryable"`
	CanViewLogs      bool        `json:"canViewLogs"`
	CanQuit          bool        `json:"canQuit"`
	CanManualInstall bool        `json:"canManualInstall"`
	UpdateCheck      string      `json:"updateCheck"`
}

type releaseSource interface {
	Discover(context.Context, string, string, ed25519.PublicKey) (*updater.SignedManifest, error)
	Download(context.Context, updater.Config, updater.Manifest, updater.Artifact, updater.Progress) (string, error)
}

type bootstrapController struct {
	mu        sync.Mutex
	state     BootstrapSnapshot
	running   bool
	ctx       context.Context
	cancel    context.CancelFunc
	workers   sync.WaitGroup
	seen      chan struct{}
	seenOnce  sync.Once
	service   *FoundationService
	paths     desktopstate.Paths
	config    updater.Config
	configErr error
	source    releaseSource
	// The controller runs only after Wails native WindowRuntimeReady.
	started bool
	openLog func() error
	emit    func(uint64)
	quit    func()
	log     *slog.Logger
}

func baseDesktopInfo() DesktopInfo {
	hostname, _ := os.Hostname()
	return DesktopInfo{Profile: string(currentProfile), Name: currentProfile.Name(), Version: version, Theme: "system", Language: "system", LocalHost: hostname, Platform: runtime.GOOS}
}
func updateConfig(paths desktopstate.Paths) (updater.Config, error) {
	c := updater.Config{Root: paths.Root, Profile: string(currentProfile), Version: version, Enabled: distributionBuild == "true"}
	if updatePublicKey != "" {
		key, e := updater.PublicKey(updatePublicKey)
		if e != nil {
			return c, e
		}
		c.Key = key
	}
	if c.Enabled && len(c.Key) == 0 {
		return c, fmt.Errorf("%w: distribution trust key unavailable", updater.ErrTrust)
	}
	return c, nil
}
func newBootstrap(s *FoundationService, paths desktopstate.Paths, logger *slog.Logger) *bootstrapController {
	ctx, cancel := context.WithCancel(context.Background())
	cfg, e := updateConfig(paths)
	return &bootstrapController{ctx: ctx, cancel: cancel, seen: make(chan struct{}), service: s, paths: paths, config: cfg, configErr: e, source: updater.NewSource(), log: logger,
		state: BootstrapSnapshot{Revision: 1, Phase: "initializing", Info: baseDesktopInfo(), CurrentVersion: version, CanQuit: true, UpdateCheck: "notChecked"}}
}
func (b *bootstrapController) snapshot() BootstrapSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}
func (b *bootstrapController) publish(edit func(*BootstrapSnapshot)) {
	b.mu.Lock()
	edit(&b.state)
	b.state.Revision++
	revision := b.state.Revision
	b.mu.Unlock()
	if b.emit != nil && b.ctx.Err() == nil {
		b.emit(revision)
	}
}
func (b *bootstrapController) phase(phase string, canQuit bool) {
	if b.log != nil {
		b.log.Info("desktop bootstrap phase", "phase", phase)
	}
	b.publish(func(s *BootstrapSnapshot) {
		s.Phase = phase
		s.CanQuit = canQuit
		s.ErrorCode = ""
		s.Retryable = false
		s.CanManualInstall = false
	})
}
func (b *bootstrapController) fail(phase, code string, err error, retry, manual bool) {
	if b.log != nil {
		b.log.Error("desktop bootstrap failed", "phase", phase, "code", code, "error", err)
	}
	b.publish(func(s *BootstrapSnapshot) {
		s.Phase = phase
		s.ErrorCode = code
		s.Retryable = retry
		s.CanQuit = true
		s.CanManualInstall = manual
	})
}
func (b *bootstrapController) start(retry bool) error {
	b.mu.Lock()
	if b.ctx.Err() != nil {
		b.mu.Unlock()
		return errors.New("Desktop is shutting down")
	}
	if b.running {
		b.mu.Unlock()
		if retry {
			return errors.New("previous bootstrap attempt is still closing")
		}
		return nil
	}
	if retry {
		if !b.started || !b.state.Retryable {
			b.mu.Unlock()
			return errors.New("bootstrap cannot safely retry this phase")
		}
	} else if b.started {
		b.mu.Unlock()
		return nil
	}
	b.started = true
	b.running = true
	b.workers.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.workers.Done()
		defer func() { b.mu.Lock(); b.running = false; b.mu.Unlock() }()
		b.run()
	}()
	return nil
}
func (b *bootstrapController) stop()         { b.cancel(); b.workers.Wait() }
func (b *bootstrapController) canQuit() bool { return b.snapshot().CanQuit }
func (b *bootstrapController) checkKind(kind string) {
	b.publish(func(s *BootstrapSnapshot) { s.UpdateCheck = kind })
}

func (b *bootstrapController) run() {
	b.publish(func(s *BootstrapSnapshot) {
		s.Phase = "storage"
		s.TargetVersion = ""
		s.DownloadedBytes = 0
		s.TotalBytes = 0
		s.ErrorCode = ""
		s.Retryable = false
		s.CanManualInstall = false
		s.CanQuit = false
		s.UpdateCheck = "notChecked"
	})
	if b.openLog != nil {
		if e := b.openLog(); e != nil {
			b.fail("initializationFailed", "storage", e, true, false)
			return
		}
	}
	b.publish(func(s *BootstrapSnapshot) { s.CanViewLogs = true })
	if b.configErr != nil {
		b.fail("verificationFailed", "trustConfiguration", b.configErr, false, false)
		return
	}
	// A helper may outlive the previous Wails instance. Never inspect or
	// migrate SQLite while an installer is still replacing the executable.
	var release func()
	var err error
	until := time.Now().Add(90 * time.Second)
	for {
		release, err = b.config.Lock()
		if err == nil {
			break
		}
		if !errors.Is(err, updater.ErrRecovery) || time.Now().After(until) {
			b.fail("initializationFailed", "recovery", err, true, false)
			return
		}
		b.phase("recovery", true)
		select {
		case <-b.ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
	defer func() {
		if release != nil {
			release()
		}
	}()
	state, err := b.config.Load()
	if err != nil {
		b.fail("verificationFailed", "updateState", err, false, false)
		return
	}
	if state != nil && state.Phase != "complete" && state.Phase != "required" {
		b.phase("recovery", false)
	}
	state, err = b.config.Reconcile(state)
	if err != nil {
		b.fail("verificationFailed", "updateState", err, false, false)
		return
	}
	var required bool
	if state != nil {
		m, e := b.config.Manifest(*state)
		if e != nil {
			b.fail("verificationFailed", "updateState", e, false, false)
			return
		}
		cmp, e := updater.CompareVersions(version, m.Version)
		if e != nil {
			b.fail("verificationFailed", "updateState", e, false, false)
			return
		}
		required = cmp < 0
		if required {
			b.publish(func(s *BootstrapSnapshot) { s.TargetVersion = m.Version; s.UpdateCheck = "required" })
			if state.Phase == "installFailed" || state.Phase == "permission" {
				phase := "failed"
				code := "installation"
				if state.Phase == "permission" {
					phase = "permissionFailed"
					code = "permission"
				}
				b.fail(phase, code, errors.New(state.Error), false, true)
				return
			}
		}
	}
	// Local initialization is independent of the network. A known update may
	// be installed even if the old program cannot read a newer database.
	b.phase("storage", false)
	store, openErr := desktopstate.OpenWithProgress(b.paths, currentProfile, func(phase string) { b.phase(phase, false) })
	keep := false
	if store != nil {
		defer func() {
			if !keep {
				_ = store.Close()
			}
		}()
	}
	incompatible := errors.Is(openErr, desktopstate.ErrIncompatible)
	if openErr != nil && !incompatible {
		phase := "initializationFailed"
		code := "storage"
		retry := !errors.Is(openErr, desktopstate.ErrInvalidDatabase)
		if errors.Is(openErr, desktopstate.ErrMigration) {
			phase = "migrationFailed"
			code = "migration"
		}
		b.fail(phase, code, openErr, retry, false)
		return
	}
	if store != nil {
		b.phase("configuration", false)
		theme, e := store.Theme()
		if e != nil || (theme != "system" && theme != "light" && theme != "dark") {
			b.fail("initializationFailed", "configuration", fmt.Errorf("invalid theme: %v", e), true, false)
			return
		}
		language, e := store.Language()
		if e != nil {
			b.fail("initializationFailed", "configuration", e, true, false)
			return
		}
		prefs, e := store.Preferences()
		if e != nil {
			b.fail("initializationFailed", "configuration", e, true, false)
			return
		}
		b.service.system.hide.Store(prefs.HideOnClose)
		b.publish(func(s *BootstrapSnapshot) { s.Info.Theme = theme; s.Info.Language = language })
	}
	b.phase("services", false)
	// Wails' native service lifecycle and the window-ready event already ran.
	// Notification authorization is optional, never a startup prerequisite.
	if b.ctx.Err() != nil {
		return
	}
	if b.config.Enabled {
		b.phase("checking", true)
		// A completed transaction is acknowledged only after this new process
		// has loaded its local data and a real frontend has fetched its state.
		if state != nil && state.Phase == "installed" && !required && !incompatible {
			select {
			case <-b.seen:
			case <-b.ctx.Done():
				return
			}
			if err = b.config.MarkComplete(state); err != nil {
				b.fail("verificationFailed", "updateState", err, false, false)
				return
			}
			if e := b.config.CleanupCompleted(*state); e != nil && b.log != nil {
				b.log.Warn("update cleanup incomplete; files retained", "error", e)
			}
		}
		signed, e := b.source.Discover(b.ctx, b.config.Profile, version, b.config.Key)
		if e != nil {
			if !errors.Is(e, updater.ErrNetwork) {
				b.fail("verificationFailed", "trust", e, true, false)
				return
			}
			if !required {
				b.checkKind("offline")
				if b.log != nil {
					b.log.Warn("desktop update check unavailable; no known newer version", "error", e)
				}
			}
		} else if signed != nil {
			state, e = b.config.Require(*signed)
			if e != nil {
				b.fail("verificationFailed", "updateState", e, true, false)
				return
			}
			required = true
		} else if !required {
			b.checkKind("current")
		}
	} else {
		b.checkKind("localBuild")
		if required {
			b.fail("verificationFailed", "trustConfiguration", errors.New("local build cannot bypass a signed update requirement"), false, false)
			return
		}
	}
	if required {
		m, e := b.config.Manifest(*state)
		if e != nil {
			b.fail("verificationFailed", "trust", e, false, false)
			return
		}
		a, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
		if e != nil {
			b.fail("verificationFailed", "trust", e, false, false)
			return
		}
		b.publish(func(s *BootstrapSnapshot) {
			s.Phase = "downloading"
			s.CanQuit = true
			s.TargetVersion = m.Version
			s.UpdateCheck = "required"
			s.TotalBytes = a.Size
			s.DownloadedBytes = 0
		})
		_, e = b.source.Download(b.ctx, b.config, m, a, func(done, total int64) {
			b.publish(func(s *BootstrapSnapshot) { s.DownloadedBytes = done; s.TotalBytes = total })
		})
		if e != nil {
			b.updateFailure(e)
			return
		}
		b.phase("verifying", true)
		// Native verification and helper startup re-check the artifact before
		// any replacement. No other process may install while this app owns
		// the Wails instance; the helper obtains its own OS lock before ACK.
		release()
		release = nil
		b.phase("installing", false)
		_, e = b.config.StartHelper(b.ctx, *state, a)
		if e != nil {
			b.updateFailure(e)
			return
		}
		b.phase("restarting", false)
		if b.quit != nil {
			b.quit()
		}
		return
	}
	if incompatible {
		b.fail("incompatible", "incompatible", openErr, b.config.Enabled, false)
		return
	}
	if store == nil {
		b.fail("initializationFailed", "storage", errors.New("store unavailable"), true, false)
		return
	}
	select {
	case <-b.seen:
	case <-b.ctx.Done():
		return
	}
	if b.ctx.Err() != nil {
		return
	}
	if state != nil && state.Phase == "complete" {
		if e := b.config.CleanupCompleted(*state); e != nil && b.log != nil {
			b.log.Warn("update cleanup incomplete; files retained", "error", e)
		}
	}
	b.service.store = store
	keep = true
	b.phase("ready", true)
	if b.log != nil {
		b.log.Info("desktop frontend ready", "profile", currentProfile, "updateCheck", b.snapshot().UpdateCheck)
	}
}

func (b *bootstrapController) updateFailure(err error) {
	if errors.Is(err, updater.ErrPermission) {
		b.fail("permissionFailed", "permission", err, false, true)
		return
	}
	if errors.Is(err, updater.ErrTrust) {
		b.fail("verificationFailed", "trust", err, true, false)
		return
	}
	if errors.Is(err, updater.ErrRecovery) {
		b.fail("failed", "recovery", err, true, false)
		return
	}
	b.fail("failed", "download", err, true, false)
}

// Read-only snapshot, also acknowledges that a real frontend reached the
// binding. It does not start a second initialization or waive a gate.
func (s *FoundationService) GetBootstrapState() (BootstrapSnapshot, error) {
	if s.bootstrap == nil {
		return BootstrapSnapshot{}, errors.New("bootstrap unavailable")
	}
	s.bootstrap.seenOnce.Do(func() { close(s.bootstrap.seen) })
	return s.bootstrap.snapshot(), nil
}
func (s *FoundationService) RetryBootstrap() (BootstrapSnapshot, error) {
	if s.bootstrap == nil {
		return BootstrapSnapshot{}, errors.New("bootstrap unavailable")
	}
	if e := s.bootstrap.start(true); e != nil {
		return s.bootstrap.snapshot(), e
	}
	return s.bootstrap.snapshot(), nil
}
func (s *FoundationService) OpenManualUpdate() error {
	b := s.bootstrap
	if b == nil || !b.snapshot().CanManualInstall {
		return errors.New("manual installation is not available")
	}
	unlock, e := b.config.Lock()
	if e != nil {
		return e
	}
	defer unlock()
	state, e := b.config.Load()
	if e != nil || state == nil {
		return fmt.Errorf("update state unavailable: %v", e)
	}
	m, e := b.config.Manifest(*state)
	if e != nil {
		return e
	}
	a, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return e
	}
	return b.config.OpenManualPackage(*state, a)
}
func (s *FoundationService) requireReady() error {
	// Unit tests construct a store directly. Actual application always has a
	// bootstrap controller, and no business binding may bypass its gate.
	if s.bootstrap != nil && s.bootstrap.snapshot().Phase != "ready" {
		return errors.New("Desktop bootstrap is not ready")
	}
	if s.store == nil {
		return errors.New("Desktop storage is not ready")
	}
	return nil
}
func (s *FoundationService) QuitDesktop() error {
	if s.bootstrap == nil || s.bootstrap.quit == nil {
		return errors.New("Desktop quit unavailable")
	}
	if !s.bootstrap.canQuit() {
		return errors.New("Desktop is performing a critical startup operation")
	}
	s.bootstrap.quit()
	return nil
}
