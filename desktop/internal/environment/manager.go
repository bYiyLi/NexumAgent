package environment

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"golang.org/x/crypto/ssh"
)

const LocalID = "local"

var validAttemptID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,128}$`)

type View struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Hostname           string `json:"hostname"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	AuthType           string `json:"authType"`
	Platform           string `json:"platform"`
	Arch               string `json:"arch"`
	Connected          bool   `json:"connected"`
	HasSavedCredential bool   `json:"hasSavedCredential"`
}
type Request struct {
	AttemptID  string `json:"attemptId"`
	ID         string `json:"id"` // existing environment, or empty for a new one
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	AuthType   string `json:"authType"`
	Password   string `json:"password"`
	KeyToken   string `json:"keyToken"`
	Passphrase string `json:"passphrase"`
	Remember   bool   `json:"remember"`
	UseSaved   bool   `json:"useSaved"`
}
type KeySelection struct {
	Token string `json:"token"`
	Name  string `json:"name"`
}
type Attempt struct {
	ID            string `json:"id"`
	Phase         string `json:"phase"`
	ErrorCode     string `json:"errorCode"`
	Fingerprint   string `json:"fingerprint"`
	KeyType       string `json:"keyType"`
	EnvironmentID string `json:"environmentId"`
	Warning       string `json:"warning"`
}
type Snapshot struct {
	Revision     uint64   `json:"revision"`
	Environments []View   `json:"environments"`
	Attempt      *Attempt `json:"attempt"`
}
type connectionAttempt struct {
	view   Attempt
	cancel context.CancelFunc
	trust  chan struct{}
}
type Manager struct {
	mu                sync.Mutex
	workers           sync.WaitGroup
	store             *desktopstate.Store
	vault             Vault
	local             *Local
	remote            map[string]*SSH
	pending           *connectionAttempt
	cancelled         map[string]time.Time
	keyToken, keyPath string
	keyGeneration     uint64
	revision          uint64
	closed            bool
}

func NewManager(store *desktopstate.Store, vault Vault) *Manager {
	return &Manager{store: store, vault: vault, local: NewLocal(), remote: map[string]*SSH{}, cancelled: map[string]time.Time{}, revision: 1}
}
func (m *Manager) Runtime(id string) (Runtime, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrDisconnected
	}
	if id == LocalID {
		return m.local, nil
	}
	r := m.remote[id]
	if r == nil || !r.Alive() {
		return nil, ErrDisconnected
	}
	return r, nil
}
func (m *Manager) Snapshot(ctx context.Context) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Snapshot{}, ErrDisconnected
	}
	rows, e := m.store.Environments(ctx)
	if e != nil {
		return Snapshot{}, failure("environment_store")
	}
	local := m.local.Identity()
	views := []View{{ID: LocalID, Kind: "local", Hostname: local.Hostname, Platform: local.Platform, Arch: local.Arch, Connected: true}}
	for _, r := range rows {
		connected := m.remote[r.ID] != nil && m.remote[r.ID].Alive()
		if m.remote[r.ID] != nil && !connected {
			delete(m.remote, r.ID)
			m.revision++
		}
		views = append(views, View{ID: r.ID, Kind: "ssh", Hostname: r.Hostname, Host: r.Host, Port: r.Port, Username: r.Username, AuthType: r.AuthType, Platform: r.Platform, Arch: r.Arch, Connected: connected, HasSavedCredential: r.CredentialRef != ""})
	}
	var attempt *Attempt
	if m.pending != nil {
		copy := m.pending.view
		attempt = &copy
	}
	return Snapshot{Revision: m.revision, Environments: views, Attempt: attempt}, nil
}

// Begin/Finish prevent a native dialog that returns after cancellation from
// publishing a selection into another form.
func (m *Manager) BeginKeySelection() (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return 0, ErrDisconnected
	}
	m.clearKeyLocked()
	return m.keyGeneration, nil
}

func (m *Manager) FinishKeySelection(generation uint64, path string) (KeySelection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return KeySelection{}, ErrDisconnected
	}
	if generation != m.keyGeneration {
		return KeySelection{}, failure("stale_key_selection")
	}
	m.clearKeyLocked()
	if path == "" {
		return KeySelection{}, nil
	}
	if !filepath.IsAbs(path) {
		return KeySelection{}, failure("key_unavailable")
	}
	m.keyPath = path
	m.keyToken = rand.Text()
	return KeySelection{Token: m.keyToken, Name: filepath.Base(path)}, nil
}
func (m *Manager) clearKeyLocked() {
	m.keyGeneration++
	m.keyPath = ""
	m.keyToken = ""
}

func (m *Manager) ClearKey() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clearKeyLocked()
}
func active(phase string) bool {
	return phase == "connecting" || phase == "verify" || phase == "authenticating"
}
func (m *Manager) Start(req Request) (Attempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Attempt{}, ErrDisconnected
	}
	if req.AttemptID == "" {
		req.AttemptID = rand.Text()
	}
	if !validAttemptID.MatchString(req.AttemptID) {
		return Attempt{}, failure("invalid_request")
	}
	for id, until := range m.cancelled {
		if time.Now().After(until) {
			delete(m.cancelled, id)
		}
	}
	if _, ok := m.cancelled[req.AttemptID]; ok {
		return Attempt{}, failure("cancelled")
	}
	if m.pending != nil && m.pending.view.ID == req.AttemptID {
		return m.pending.view, nil
	}
	if m.pending != nil && active(m.pending.view.Phase) {
		return Attempt{}, failure("connection_busy")
	}
	var record desktopstate.EnvironmentRecord
	var e error
	var cfg SSHConfig
	if req.ID != "" {
		record, e = m.store.Environment(context.Background(), req.ID)
		if e != nil {
			return Attempt{}, failure("environment_not_found")
		}
		cfg = SSHConfig{Host: record.Host, Port: record.Port, Username: record.Username, AuthType: record.AuthType}
		if !req.UseSaved && req.AuthType != "" {
			cfg.AuthType = req.AuthType
		}
	} else {
		if req.UseSaved {
			return Attempt{}, failure("invalid_request")
		}
		cfg = SSHConfig{Host: req.Host, Port: req.Port, Username: req.Username, AuthType: req.AuthType}
	}
	cfg, e = NormalizeConfig(cfg)
	if e != nil {
		return Attempt{}, e
	}
	if record.ID == "" {
		old, err := m.store.FindEnvironment(context.Background(), cfg.Host, cfg.Port, cfg.Username)
		if err == nil {
			record = old
		} else if !errors.Is(err, sql.ErrNoRows) {
			return Attempt{}, failure("environment_store")
		}
	}
	if record.ID == "" {
		record = desktopstate.EnvironmentRecord{ID: rand.Text(), Host: cfg.Host, Port: cfg.Port, Username: cfg.Username}
	}
	if r := m.remote[record.ID]; r != nil && r.Alive() {
		return Attempt{}, failure("already_connected")
	}
	if req.UseSaved && record.CredentialRef == "" && cfg.AuthType != "agent" {
		return Attempt{}, failure("credentials_required")
	}
	secret := Secret{}
	if !req.UseSaved {
		switch cfg.AuthType {
		case "password":
			secret.Password = req.Password
		case "key":
			if req.KeyToken == "" || req.KeyToken != m.keyToken {
				return Attempt{}, failure("key_unavailable")
			}
			secret.KeyPath = m.keyPath
			secret.Passphrase = req.Passphrase
		}
		if e = validateSecret(cfg, secret); e != nil {
			return Attempt{}, e
		}
	}
	m.clearKeyLocked()
	if cfg.AuthType == "agent" {
		req.Remember = false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	a := &connectionAttempt{view: Attempt{ID: req.AttemptID, Phase: "connecting"}, cancel: cancel, trust: make(chan struct{}, 1)}
	m.pending = a
	m.revision++
	view := a.view
	m.workers.Add(1)
	// Do not retain the request (including its secret fields) beyond admission.
	go m.connect(ctx, a, cfg, record, secret, req.Remember, req.UseSaved)
	return view, nil
}
func (m *Manager) publish(a *connectionAttempt, change func(*Attempt)) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.pending != a {
		return false
	}
	change(&a.view)
	m.revision++
	return true
}
func (m *Manager) fail(a *connectionAttempt, err error) {
	code := ErrorCode(err)
	phase := "failed"
	if code == "host_changed" {
		phase = "hostChanged"
	}
	if code == "auth_failed" || code == "key_invalid" || code == "key_passphrase_required" || code == "key_unavailable" || code == "ssh_agent_unavailable" || code == "credentials_required" {
		phase = "authFailed"
	}
	m.publish(a, func(v *Attempt) { v.Phase = phase; v.ErrorCode = code })
}
func (m *Manager) connect(ctx context.Context, a *connectionAttempt, cfg SSHConfig, record desktopstate.EnvironmentRecord, secret Secret, remember, useSaved bool) {
	defer m.workers.Done()
	defer a.cancel()
	if useSaved && cfg.AuthType != "agent" {
		var e error
		secret, e = m.vault.Get(record.CredentialRef)
		if e != nil {
			m.fail(a, failure("credentials_required"))
			return
		}
	}
	known, e := m.store.TrustedHost(ctx, cfg.Host, cfg.Port)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		m.fail(a, failure("environment_store"))
		return
	}
	pinned := e == nil
	var actual desktopstate.HostKey
	remote, e := Dial(ctx, cfg, secret, func(key ssh.PublicKey) error {
		actual = desktopstate.HostKey{Type: key.Type(), Fingerprint: ssh.FingerprintSHA256(key)}
		if pinned && known != actual {
			m.publish(a, func(v *Attempt) { v.Fingerprint = actual.Fingerprint; v.KeyType = actual.Type })
			return failure("host_changed")
		}
		if !pinned {
			if !m.publish(a, func(v *Attempt) { v.Phase = "verify"; v.Fingerprint = actual.Fingerprint; v.KeyType = actual.Type }) {
				return context.Canceled
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-a.trust:
			}
		}
		if !m.publish(a, func(v *Attempt) { v.Phase = "authenticating" }) {
			return context.Canceled
		}
		return ctx.Err()
	})
	if e != nil {
		m.fail(a, e)
		return
	}
	adopted := false
	defer func() {
		if !adopted {
			_ = remote.Close()
		}
	}()
	oldRef := record.CredentialRef
	newRef := ""
	if useSaved && cfg.AuthType != "agent" {
		newRef = oldRef
	}
	if remember && !useSaved && cfg.AuthType != "agent" {
		newRef = rand.Text()
		if e = m.vault.Put(newRef, secret); e != nil {
			m.fail(a, failure("credential_store"))
			return
		}
	}
	secret = Secret{}
	record.AuthType = cfg.AuthType
	record.CredentialRef = newRef
	identity := remote.Identity()
	record.Hostname = identity.Hostname
	record.Platform = identity.Platform
	record.Arch = identity.Arch
	m.mu.Lock()
	if m.closed || m.pending != a || ctx.Err() != nil || !remote.Alive() {
		m.mu.Unlock()
		if newRef != "" && newRef != oldRef {
			_ = m.vault.Delete(newRef)
		}
		if ctx.Err() != nil {
			m.fail(a, ctx.Err())
		} else {
			m.fail(a, failure("connection_lost"))
		}
		return
	}
	// Serializing the last persistence/selection with cancellation ensures a
	// cancelled attempt cannot publish a new environment after cancellation.
	e = m.store.SaveEnvironment(ctx, record, actual)
	if e == nil {
		if old := m.remote[record.ID]; old != nil {
			_ = old.Close()
		}
		m.remote[record.ID] = remote
		adopted = true
		a.view.Phase = "connected"
		a.view.EnvironmentID = record.ID
		m.revision++
	}
	m.mu.Unlock()
	if e != nil {
		if newRef != "" && newRef != oldRef {
			_ = m.vault.Delete(newRef)
		}
		if errors.Is(e, desktopstate.ErrHostKeyChanged) {
			m.fail(a, failure("host_changed"))
		} else {
			m.fail(a, failure("environment_store"))
		}
		return
	}
	if oldRef != "" && oldRef != newRef {
		if e = m.vault.Delete(oldRef); e != nil {
			m.publish(a, func(v *Attempt) { v.Warning = "credential_cleanup_failed" })
		}
	}
}
func (m *Manager) Trust(id, fingerprint string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.pending
	if a == nil || a.view.ID != id || a.view.Phase != "verify" || a.view.Fingerprint != fingerprint || fingerprint == "" {
		return failure("stale_host_confirmation")
	}
	a.view.Phase = "authenticating"
	m.revision++
	a.trust <- struct{}{}
	return nil
}
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !validAttemptID.MatchString(id) {
		return failure("invalid_request")
	}
	// A cancel may reach the binding before Start. Remember recent cancelled
	// admissions so a delayed request cannot create a connection.
	if len(m.cancelled) >= 64 {
		var oldest string
		var deadline time.Time
		for k, v := range m.cancelled {
			if oldest == "" || v.Before(deadline) {
				oldest = k
				deadline = v
			}
		}
		delete(m.cancelled, oldest)
	}
	m.cancelled[id] = time.Now().Add(5 * time.Minute)
	if m.pending == nil || m.pending.view.ID != id {
		return nil
	}
	if active(m.pending.view.Phase) {
		m.pending.cancel()
	}
	m.pending = nil
	m.revision++
	m.clearKeyLocked()
	return nil
}
func (m *Manager) Disconnect(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == LocalID {
		return failure("local_environment")
	}
	if m.pending != nil && active(m.pending.view.Phase) {
		return failure("connection_busy")
	}
	if r := m.remote[id]; r != nil {
		_ = r.Close()
		delete(m.remote, id)
		m.revision++
	}
	return nil
}
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || id == LocalID {
		return failure("invalid_request")
	}
	if m.pending != nil && active(m.pending.view.Phase) {
		return failure("connection_busy")
	}
	row, e := m.store.Environment(context.Background(), id)
	if e != nil {
		return failure("environment_not_found")
	}
	if row.CredentialRef != "" {
		if e = m.vault.Delete(row.CredentialRef); e != nil {
			return failure("credential_store")
		}
	}
	if e = m.store.RemoveEnvironment(context.Background(), id); e != nil {
		return failure("environment_store")
	}
	if r := m.remote[id]; r != nil {
		_ = r.Close()
		delete(m.remote, id)
	}
	m.revision++
	return nil
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	if m.pending != nil {
		m.pending.cancel()
		m.pending = nil
	}
	m.clearKeyLocked()
	for _, r := range m.remote {
		_ = r.Close()
	}
	m.remote = map[string]*SSH{}
	m.mu.Unlock()
	m.workers.Wait()
}
