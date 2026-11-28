//go:build !windows

package environment

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	sshagent "golang.org/x/crypto/ssh/agent"
)

type testVault struct {
	mu      sync.Mutex
	entries map[string]Secret
}

func (v *testVault) Put(id string, s Secret) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.entries[id] = s
	return nil
}
func (v *testVault) Get(id string) (Secret, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.entries[id]
	if !ok {
		return Secret{}, ErrCredentialMissing
	}
	return s, nil
}
func (v *testVault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.entries, id)
	return nil
}

type fixtureServer struct {
	listener    net.Listener
	ctx         context.Context
	cancel      context.CancelFunc
	password    string
	fingerprint string
	authCalls   atomic.Int32
	workers     sync.WaitGroup
}

func keyPair(t *testing.T) (ssh.Signer, ed25519.PrivateKey) {
	t.Helper()
	_, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	signer, e := ssh.NewSignerFromKey(key)
	if e != nil {
		t.Fatal(e)
	}
	return signer, key
}

// A loopback-only fixture with generated credentials. Exec accepts only
// the fixed test cases; SFTP uses a real temporary filesystem.
func startFixture(t *testing.T, addr string, authorized ssh.PublicKey) *fixtureServer {
	t.Helper()
	host, _ := keyPair(t)
	listener, e := net.Listen("tcp", addr)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f := &fixtureServer{listener: listener, ctx: ctx, cancel: cancel, password: rand.Text(), fingerprint: ssh.FingerprintSHA256(host.PublicKey())}
	config := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			f.authCalls.Add(1)
			if c.User() == "fixture" && string(password) == f.password {
				return nil, nil
			}
			return nil, errors.New("fixture auth rejected")
		},
		PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			f.authCalls.Add(1)
			if c.User() == "fixture" && authorized != nil && string(key.Marshal()) == string(authorized.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("fixture key rejected")
		},
	}
	config.AddHostKey(host)
	f.workers.Add(1)
	go func() {
		defer f.workers.Done()
		for {
			raw, e := listener.Accept()
			if e != nil {
				return
			}
			f.workers.Add(1)
			go func() {
				defer f.workers.Done()
				defer raw.Close()
				stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
				defer stop()
				conn, channels, requests, e := ssh.NewServerConn(raw, config)
				if e != nil {
					return
				}
				defer conn.Close()
				go ssh.DiscardRequests(requests)
				var sessions sync.WaitGroup
				for incoming := range channels {
					if incoming.ChannelType() != "session" {
						_ = incoming.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					ch, reqs, e := incoming.Accept()
					if e != nil {
						continue
					}
					sessions.Add(1)
					go func() { defer sessions.Done(); serveFixture(ctx, ch, reqs) }()
				}
				sessions.Wait()
			}()
		}
	}()
	t.Cleanup(f.close)
	return f
}
func (f *fixtureServer) close() { f.cancel(); _ = f.listener.Close(); f.workers.Wait() }
func (f *fixtureServer) request() Request {
	host, port, _ := net.SplitHostPort(f.listener.Addr().String())
	n, _ := strconv.Atoi(port)
	return Request{Host: host, Port: n, Username: "fixture", AuthType: "password", Password: f.password}
}
func serveFixture(ctx context.Context, ch ssh.Channel, requests <-chan *ssh.Request) {
	defer ch.Close()
	for req := range requests {
		switch req.Type {
		case "subsystem":
			var payload struct{ Name string }
			if ssh.Unmarshal(req.Payload, &payload) != nil || payload.Name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			server, e := sftp.NewServer(ch)
			if e != nil {
				return
			}
			defer server.Close()
			_ = server.Serve()
			return
		case "exec":
			var payload struct{ Command string }
			if ssh.Unmarshal(req.Payload, &payload) != nil {
				_ = req.Reply(false, nil)
				return
			}
			_ = req.Reply(true, nil)
			code := uint32(0)
			probe := "uname -s && uname -m && hostname && printf '%s\\n' \"$HOME\" && id -un"
			quoted, _ := remoteCommand("darwin", Command{Program: "printf", Args: []string{"%s", "spaces and ' quotes"}})
			switch payload.Command {
			case probe:
				cmd := exec.CommandContext(ctx, "/bin/sh", "-c", probe)
				cmd.Stdout = ch
				cmd.Stderr = ch.Stderr()
				if e := cmd.Run(); e != nil {
					code = 1
				}
			case quoted:
				cmd := exec.CommandContext(ctx, "/bin/sh", "-c", quoted)
				cmd.Stdout = ch
				cmd.Stderr = ch.Stderr()
				if e := cmd.Run(); e != nil {
					code = 1
				}
			case "printf '%s' \"$HOME\"":
				_, _ = io.WriteString(ch, "/fixture/home")
			case "exec env -- 'sleep' '10'":
				select {
				case <-ctx.Done():
					return
				case <-time.After(10 * time.Second):
				}
			default:
				code = 127
			}
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}
func managerFor(t *testing.T) (*Manager, *desktopstate.Store, *testVault) {
	t.Helper()
	paths, e := desktopstate.ResolveAt(t.TempDir(), desktopstate.Development)
	if e != nil {
		t.Fatal(e)
	}
	store, e := desktopstate.Open(paths, desktopstate.Development)
	if e != nil {
		t.Fatal(e)
	}
	vault := &testVault{entries: map[string]Secret{}}
	m := NewManager(store, vault)
	t.Cleanup(func() { m.Close(); _ = store.Close() })
	return m, store, vault
}
func waitPhase(t *testing.T, m *Manager, id string, phases ...string) Attempt {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s, e := m.Snapshot(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		if s.Attempt != nil && s.Attempt.ID == id {
			for _, p := range phases {
				if s.Attempt.Phase == p {
					return *s.Attempt
				}
			}
			if s.Attempt.Phase == "failed" || s.Attempt.Phase == "authFailed" || s.Attempt.Phase == "hostChanged" {
				t.Fatalf("unexpected terminal phase: %+v", s.Attempt)
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("attempt %s did not enter %v", id, phases)
	return Attempt{}
}
func startAndTrust(t *testing.T, m *Manager, f *fixtureServer, req Request) Attempt {
	t.Helper()
	a, e := m.Start(req)
	if e != nil {
		t.Fatal(e)
	}
	v := waitPhase(t, m, a.ID, "verify")
	if v.Fingerprint != f.fingerprint || f.authCalls.Load() != 0 {
		t.Fatal("authentication started before host trust", v)
	}
	if e = m.Trust(a.ID, "SHA256:invalid"); e == nil {
		t.Fatal("wrong fingerprint accepted")
	}
	if e = m.Trust(a.ID, v.Fingerprint); e != nil {
		t.Fatal(e)
	}
	return waitPhase(t, m, a.ID, "connected")
}

func TestSSHManagerRealProtocol(t *testing.T) {
	f := startFixture(t, "127.0.0.1:0", nil)
	m, store, vault := managerFor(t)
	req := f.request()
	req.Remember = true
	done := startAndTrust(t, m, f, req)
	record, e := store.Environment(context.Background(), done.EnvironmentID)
	if e != nil || record.CredentialRef == "" || record.Hostname == "" {
		t.Fatalf("stored environment: %+v %v", record, e)
	}
	if stored, e := vault.Get(record.CredentialRef); e != nil || stored.Password != f.password {
		t.Fatal("remembered credential not in vault")
	}
	runtime, e := m.Runtime(record.ID)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	result, e := runtime.Run(ctx, Command{Program: "printf", Args: []string{"%s", "spaces and ' quotes"}})
	if e != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Stdout != "spaces and ' quotes" {
		t.Fatalf("remote command: %+v %v", result, e)
	}
	if v, e := runtime.Getenv(ctx, "HOME"); e != nil || v != "/fixture/home" {
		t.Fatal(v, e)
	}
	root := t.TempDir()
	target, e := runtime.Join(root, "nested", "value.txt")
	if e != nil {
		t.Fatal(e)
	}
	if e = runtime.MkdirAll(ctx, filepath.Dir(target), 0700); e != nil {
		t.Fatal(e)
	}
	if e = runtime.WriteFile(ctx, target, []byte("hello"), 0600); e != nil {
		t.Fatal(e)
	}
	if b, e := runtime.ReadFile(ctx, target, 100); e != nil || string(b) != "hello" {
		t.Fatal(string(b), e)
	}
	if e = runtime.WriteFile(ctx, target, []byte("new"), 0600); e != nil {
		t.Fatal(e)
	}
	if i, e := runtime.Stat(ctx, target); e != nil || i.Size() != 3 {
		t.Fatal(i, e)
	}
	if rows, e := runtime.ReadDir(ctx, filepath.Dir(target)); e != nil || len(rows) != 1 {
		t.Fatal(rows, e)
	}
	src := filepath.Join(root, "upload")
	if e = os.WriteFile(src, []byte("transfer"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = runtime.Upload(ctx, src, target, 0600); e != nil {
		t.Fatal(e)
	}
	dst := filepath.Join(root, "download")
	if e = runtime.Download(ctx, target, dst, 0600); e != nil {
		t.Fatal(e)
	}
	if b, e := os.ReadFile(dst); e != nil || string(b) != "transfer" {
		t.Fatal(string(b), e)
	}
	// A known non-zero exit is not a transport failure.
	if r, e := runtime.Run(ctx, Command{Program: "false"}); e != nil || !r.OutcomeKnown || r.ExitCode != 127 {
		t.Fatal(r, e)
	}
	short, stop := context.WithTimeout(ctx, 150*time.Millisecond)
	defer stop()
	r, e := runtime.Run(short, Command{Program: "sleep", Args: []string{"10"}})
	if !errors.Is(e, ErrUnknownOutcome) || r.OutcomeKnown || runtime.Alive() {
		t.Fatal("unknown outcome not preserved", r, e)
	}
	a, e := m.Start(Request{ID: record.ID, UseSaved: true})
	if e != nil {
		t.Fatal(e)
	}
	again := waitPhase(t, m, a.ID, "connected")
	if again.EnvironmentID != record.ID {
		t.Fatal("reconnect created duplicate")
	}
	if e = m.Disconnect(record.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Runtime(record.ID); !errors.Is(e, ErrDisconnected) {
		t.Fatal("disconnected runtime available", e)
	}
	if e = m.Remove(record.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = vault.Get(record.CredentialRef); !errors.Is(e, ErrCredentialMissing) {
		t.Fatal("credential not removed", e)
	}
	if k, e := store.TrustedHost(ctx, record.Host, record.Port); e != nil || k.Fingerprint != f.fingerprint {
		t.Fatal("host trust unexpectedly removed", k, e)
	}
}
func TestCancelledAndChangedHostNeverAuthenticate(t *testing.T) {
	f := startFixture(t, "127.0.0.1:0", nil)
	m, store, _ := managerFor(t)
	ctx := context.Background()
	req := f.request()
	a, e := m.Start(req)
	if e != nil {
		t.Fatal(e)
	}
	v := waitPhase(t, m, a.ID, "verify")
	if e = m.Cancel(a.ID); e != nil {
		t.Fatal(e)
	}
	if e = m.Trust(a.ID, v.Fingerprint); e == nil {
		t.Fatal("late confirmation accepted")
	}
	if rows, e := store.Environments(ctx); e != nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
	if f.authCalls.Load() != 0 {
		t.Fatal("cancelled host was authenticated")
	}
	req.AttemptID = rand.Text()
	if e = m.Cancel(req.AttemptID); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Start(req); ErrorCode(e) != "cancelled" {
		t.Fatal("delayed admission accepted", e)
	}
	req.AttemptID = ""
	done := startAndTrust(t, m, f, req)
	if e = m.Disconnect(done.EnvironmentID); e != nil {
		t.Fatal(e)
	}
	addr := f.listener.Addr().String()
	f.close()
	other := startFixture(t, addr, nil)
	next := other.request()
	next.ID = done.EnvironmentID
	a, e = m.Start(next)
	if e != nil {
		t.Fatal(e)
	}
	failed := waitPhase(t, m, a.ID, "hostChanged")
	if failed.ErrorCode != "host_changed" || other.authCalls.Load() != 0 {
		t.Fatal("changed host was authenticated", failed)
	}
	if e = m.Trust(a.ID, failed.Fingerprint); e == nil {
		t.Fatal("host change override accepted")
	}
	if rows, e := store.Environments(ctx); e != nil || len(rows) != 1 {
		t.Fatal(rows, e)
	}
}
func TestPrivateKeyAndSystemAgentAuthentication(t *testing.T) {
	signer, key := keyPair(t)
	t.Run("encrypted private key", func(t *testing.T) {
		f := startFixture(t, "127.0.0.1:0", signer.PublicKey())
		m, _, _ := managerFor(t)
		passphrase := rand.Text()
		block, e := ssh.MarshalPrivateKeyWithPassphrase(key, "fixture", []byte(passphrase))
		if e != nil {
			t.Fatal(e)
		}
		file := filepath.Join(t.TempDir(), "id_ed25519")
		if e = os.WriteFile(file, pem.EncodeToMemory(block), 0600); e != nil {
			t.Fatal(e)
		}
		generation, e := m.BeginKeySelection()
		if e != nil {
			t.Fatal(e)
		}
		chosen, e := m.FinishKeySelection(generation, file)
		if e != nil {
			t.Fatal(e)
		}
		req := f.request()
		req.AuthType = "key"
		req.Password = ""
		req.KeyToken = chosen.Token
		req.Passphrase = passphrase
		done := startAndTrust(t, m, f, req)
		if done.EnvironmentID == "" {
			t.Fatal(done)
		}
	})
	t.Run("system SSH agent", func(t *testing.T) {
		f := startFixture(t, "127.0.0.1:0", signer.PublicKey())
		m, _, _ := managerFor(t)
		ring := sshagent.NewKeyring()
		if e := ring.Add(sshagent.AddedKey{PrivateKey: key}); e != nil {
			t.Fatal(e)
		}
		// macOS Unix socket path has a short length limit.
		dir, e := os.MkdirTemp("/tmp", "nx-ssh-agent-")
		if e != nil {
			t.Fatal(e)
		}
		defer os.RemoveAll(dir)
		socket := filepath.Join(dir, "a.sock")
		listener, e := net.Listen("unix", socket)
		if e != nil {
			t.Fatal(e)
		}
		defer listener.Close()
		t.Setenv("SSH_AUTH_SOCK", socket)
		done := make(chan error, 1)
		go func() {
			conn, e := listener.Accept()
			if e != nil {
				done <- e
				return
			}
			defer conn.Close()
			done <- sshagent.ServeAgent(ring, conn)
		}()
		req := f.request()
		req.AuthType = "agent"
		req.Password = ""
		result := startAndTrust(t, m, f, req)
		if result.EnvironmentID == "" {
			t.Fatal(result)
		}
		select {
		case e := <-done:
			if e != nil && !strings.Contains(e.Error(), "EOF") {
				t.Fatal(fmt.Errorf("agent fixture: %w", e))
			}
		case <-time.After(3 * time.Second):
			t.Fatal("agent socket not released")
		}
	})
}
