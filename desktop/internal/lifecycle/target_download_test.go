package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type isolatedLocalRuntime struct {
	environment.Runtime
	identity  environment.Identity
	interrupt bool
	denyRead  string
}

func (r *isolatedLocalRuntime) Identity() environment.Identity { return r.identity }

func (r *isolatedLocalRuntime) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	if r.denyRead != "" && filepath.Base(path) == r.denyRead {
		return nil, errors.New("unexpected binary transfer")
	}
	return r.Runtime.ReadFile(ctx, path, limit)
}

func (r *isolatedLocalRuntime) Run(ctx context.Context, command environment.Command) (environment.Result, error) {
	if r.interrupt && command.Program == "curl" {
		return environment.Result{Started: true}, environment.ErrUnknownOutcome
	}
	return r.Runtime.Run(ctx, command)
}

func localTarget(t *testing.T) *isolatedLocalRuntime {
	t.Helper()
	base := environment.NewLocal()
	identity := base.Identity()
	identity.Home = t.TempDir()
	return &isolatedLocalRuntime{Runtime: base, identity: identity}
}

func TestPrepareInstallUsesTargetDownloads(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires the Unix target downloader")
	}
	rt := localTarget(t)
	var mu sync.Mutex
	var agents []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		agents = append(agents, r.UserAgent())
		mu.Unlock()
		switch r.URL.Path {
		case "/agent/native/manifest.json":
			_ = json.NewEncoder(w).Encode(manifest{Version: "1.2.3", Artifacts: []artifact{{OS: rt.identity.Platform, Arch: rt.identity.Arch, Name: "nexum-agent-" + rt.identity.Platform + "-" + rt.identity.Arch, SHA256: strings.Repeat("a", 64), Size: 42}}})
		case "/agent/install.sh":
			_, _ = w.Write([]byte("#!/bin/sh\n# NEXUM_DESKTOP_INSTALL_PROTOCOL=1\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	plan, err := prepareInstall(context.Background(), rt, server.URL, "development", nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.version != "1.2.3" || !strings.HasPrefix(plan.scriptPath, rt.identity.Home+string(os.PathSeparator)) {
		t.Fatalf("installer was not staged on the target: %+v", plan)
	}
	if _, err := os.Stat(plan.scriptPath); err != nil {
		t.Fatal(err)
	}
	plan.cleanup()
	if _, err := os.Stat(plan.scriptPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("installer cleanup: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(agents) != 2 {
		t.Fatalf("unexpected requests: %v", agents)
	}
	for _, agent := range agents {
		if !strings.HasPrefix(agent, "curl/") {
			t.Fatalf("request did not use target curl: %q", agent)
		}
	}
}

func TestTargetDownloadRejectsFailuresAndUnknownOutcome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires the Unix target downloader")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/success", http.StatusFound)
		case "/large":
			_, _ = w.Write([]byte(strings.Repeat("x", 1024)))
		default:
			_, _ = w.Write([]byte("ok"))
		}
	}))
	defer server.Close()
	for _, tc := range []struct {
		name, path, want string
		interrupt        bool
	}{
		{"redirect", "/redirect", "target_download_failed", false},
		{"oversized", "/large", "target_download_failed", false},
		{"disconnected", "/success", "target_download_unconfirmed", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt := localTarget(t)
			rt.interrupt = tc.interrupt
			_, _, err := stageTargetDownload(context.Background(), rt, server.URL, "development", tc.path, "file", 32)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("got %v, want %s", err, tc.want)
			}
			entries, err := os.ReadDir(rt.identity.Home)
			if err != nil || len(entries) != 0 {
				t.Fatalf("temporary files remain: %v %v", entries, err)
			}
		})
	}
}

func TestVerifyTargetArtifactChecksSizeAndDigest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires the Unix target checksum tool")
	}
	rt := localTarget(t)
	body := []byte("sample native program")
	path := filepath.Join(rt.identity.Home, "agent")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	want := artifact{Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
	if err := verifyTargetArtifact(context.Background(), rt, path, want); err != nil {
		t.Fatal(err)
	}
	for _, changed := range []artifact{{Size: want.Size + 1, SHA256: want.SHA256}, {Size: want.Size, SHA256: fmt.Sprintf("%064d", 0)}} {
		if err := verifyTargetArtifact(context.Background(), rt, path, changed); err == nil {
			t.Fatal("accepted a mismatched artifact")
		}
	}
}

func TestRepairArtifactStaysOnTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires the Unix target downloader")
	}
	rt := localTarget(t)
	rt.denyRead = "nexum-agent"
	body := []byte("sample native program")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.UserAgent(), "curl/") {
			t.Errorf("request did not originate from target curl: %q", r.UserAgent())
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()
	sum := sha256.Sum256(body)
	expected := artifact{Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
	path, cleanup, err := stageTargetDownload(context.Background(), rt, server.URL, "development", "/agent/native/fixture", "nexum-agent", expected.Size)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err := verifyTargetArtifact(context.Background(), rt, path, expected); err != nil {
		t.Fatal(err)
	}
}

func TestCapabilityReadWhenAgentCloudIsOffline(t *testing.T) {
	c := capabilityController(t, func(environment.Command) (environment.Result, error) {
		data, _ := json.Marshal(capabilityOutput())
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	c.current.state.Summary.Cloud = "offline"
	result, err := c.Capabilities("local", "operation", "agent", "boot")
	if err != nil || result.State != "available" || len(result.Items) != 3 {
		t.Fatalf("offline capability read: %+v, %v", result, err)
	}
}

func TestAuthorizationCancelUsesBoundVerifier(t *testing.T) {
	var origin, challenge string
	var paths []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.URL.Path)
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		switch r.URL.Path {
		case "/api/desktop-install/start":
			challenge = body["codeChallenge"]
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(authorizationIntent{RequestID: "cancel-fixture", AuthorizationURL: origin + "/auth/desktop-install?request_id=cancel-fixture", ExpiresAt: time.Now().Add(time.Minute)})
		case "/api/desktop-install/cancel":
			sum := sha256.Sum256([]byte(body["codeVerifier"]))
			if body["requestId"] != "cancel-fixture" || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
				t.Error("cancellation was not bound to the authorization")
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected direct request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	origin = server.URL
	a, err := newAuthorization(context.Background(), origin, "development", "initialize", "local", "", testIdentity(), "en-US")
	if err != nil {
		t.Fatal(err)
	}
	defer a.close()
	a.cancelRequest()
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(paths, ",") != "/api/desktop-install/start,/api/desktop-install/cancel" {
		t.Fatalf("unexpected direct request sequence: %v", paths)
	}
}

func TestTargetDownloadReportsActualBytes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix direct curl fixture")
	}
	rt := localTarget(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "8")
		_, _ = w.Write([]byte("abcd"))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(1500 * time.Millisecond):
		}
		_, _ = w.Write([]byte("efgh"))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var got []int64
	path, cleanup, err := stageTargetDownload(ctx, rt, server.URL, "development", "/fixture", "native", 8, func(done, total int64) {
		if total != 8 {
			t.Errorf("wrong total: %d", total)
		}
		got = append(got, done)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if len(got) < 3 || got[0] != 0 || got[len(got)-1] != 8 {
		t.Fatalf("missing real intermediate progress: %v", got)
	}
	seen := false
	for i, n := range got {
		if i > 0 && n < got[i-1] {
			t.Fatalf("nonmonotonic progress: %v", got)
		}
		if n == 4 {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("did not observe first four bytes: %v", got)
	}
	if body, e := os.ReadFile(path); e != nil || string(body) != "abcdefgh" {
		t.Fatalf("staged bytes: %q %v", body, e)
	}
}

func TestTargetDownloadInterruptedProgressDoesNotClaimSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix fixture")
	}
	rt := localTarget(t)
	rt.interrupt = true
	var got []int64
	_, _, err := stageTargetDownload(context.Background(), rt, "http://127.0.0.1:1", "development", "/fixture", "native", 8, func(done, total int64) { got = append(got, done) })
	if err == nil || err.Error() != "target_download_unconfirmed" || len(got) != 1 || got[0] != 0 {
		t.Fatalf("interruption: %v %v", err, got)
	}
	entries, e := os.ReadDir(rt.identity.Home)
	if e != nil || len(entries) != 0 {
		t.Fatalf("staging left behind: %v %v", entries, e)
	}
}
