package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func validTestFacts() Facts {
	return Facts{Protocol: Protocol, Profile: "development", Platform: "darwin", Arch: "arm64", Root: "present", Program: "present", Config: "valid", Credential: "valid", Service: "stopped", Version: "1.2.3", RequiredVersion: "1.2.3", AgentID: "agent-test", AgentName: "Test Agent"}
}
func testIdentity() environment.Identity {
	return environment.Identity{Hostname: "test-host", Platform: "darwin", Arch: "arm64", Home: "/test-home", Username: "test-user"}
}
func TestLifecycleClassification(t *testing.T) {
	cases := []struct {
		name          string
		change        func(*Facts)
		stage, reason string
	}{
		{"stopped", func(f *Facts) {}, "start", "service_stopped"},
		{"absent", func(f *Facts) { f.Root = "missing" }, "initialize", "not_installed"},
		{"unsafe", func(f *Facts) { f.Root = "unsafe" }, "blocked", "unsafe_or_unknown_directory"},
		{"missing binary", func(f *Facts) { f.Program = "missing" }, "repair", "program_missing"},
		{"broken binary", func(f *Facts) { f.Program = "invalid" }, "blocked", "program_invalid"},
		{"config mismatch", func(f *Facts) { f.Config = "mismatch" }, "blocked", "configuration"},
		{"confirmed missing credentials", func(f *Facts) { f.Config = "unauthorized"; f.Credential = "missing" }, "configure", "credential_missing_or_invalid"},
		{"invalid credential", func(f *Facts) { f.Credential = "invalid" }, "configure", "credential_missing_or_invalid"},
		{"unknown credential", func(f *Facts) { f.Credential = "unknown" }, "network", "credential_unconfirmed"},
		{"service missing", func(f *Facts) { f.Service = "missing" }, "repair", "service_missing"},
		{"uninstalled with missing configuration", func(f *Facts) { f.Service = "missing"; f.Config = "missing"; f.Credential = "missing" }, "configure", "credential_missing_or_invalid"},
		{"uninstalled with missing credential", func(f *Facts) { f.Service = "missing"; f.Config = "unauthorized"; f.Credential = "missing" }, "configure", "credential_missing_or_invalid"},
		{"missing configuration and unknown identity", func(f *Facts) { f.Service = "missing"; f.Config = "missing"; f.AgentID = "" }, "blocked", "service_identity_unconfirmed"},
		{"service mismatch", func(f *Facts) { f.Service = "invalid" }, "blocked", "service_identity_unconfirmed"},
		{"running without management", func(f *Facts) { f.Service = "running" }, "connecting", "waiting_for_management"},
		{"running old version", func(f *Facts) { f.Service = "running"; f.Version = "1.2.2" }, "upgrade", "version_incompatible"},
		{"ready", func(f *Facts) {
			f.Service = "running"
			f.Live = &Live{Protocol: Protocol, Profile: f.Profile, Platform: f.Platform, Arch: f.Arch, Version: f.Version, BootID: "boot-test", AgentID: f.AgentID, Phase: "running", OriginMatches: true, ExecutionReady: true, CloudOnline: true}
		}, "ready", "management_verified"},
		{"wrong identity", func(f *Facts) {
			f.Service = "running"
			f.Live = &Live{Phase: "running", AgentID: "different", BootID: "boot", OriginMatches: true}
		}, "blocked", "management_identity_mismatch"},
		{"wrong origin", func(f *Facts) {
			f.Service = "running"
			f.Live = &Live{Phase: "running", AgentID: f.AgentID, BootID: "boot"}
		}, "blocked", "management_identity_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := validTestFacts()
			tc.change(&f)
			got := classify(f, testIdentity())
			if got.Stage != tc.stage || got.Reason != tc.reason {
				t.Fatalf("got %s/%s, want %s/%s", got.Stage, got.Reason, tc.stage, tc.reason)
			}
			if (got.Summary != nil) != (tc.stage == "ready") {
				t.Fatal("summary requires verified ready")
			}
		})
	}
	f := validTestFacts()
	f.Profile = "production"
	if validFacts(f, testIdentity(), "development") {
		t.Fatal("cross-profile facts accepted")
	}
}

type fixtureInfo struct{ dir bool }

func (f fixtureInfo) Name() string { return "fixture" }
func (f fixtureInfo) Size() int64  { return 128 }
func (f fixtureInfo) Mode() fs.FileMode {
	if f.dir {
		return fs.ModeDir | 0700
	}
	return 0700
}
func (f fixtureInfo) ModTime() time.Time { return time.Time{} }
func (f fixtureInfo) IsDir() bool        { return f.dir }
func (f fixtureInfo) Sys() any           { return nil }

type fixtureRuntime struct {
	environment.Runtime
	mu       sync.Mutex
	f        Facts
	starts   int
	unknown  bool
	missing  bool
	progress bool
}

func (f *fixtureRuntime) Identity() environment.Identity { return testIdentity() }
func (f *fixtureRuntime) Alive() bool                    { return true }
func (f *fixtureRuntime) Join(base string, parts ...string) (string, error) {
	return path.Join(append([]string{base}, parts...)...), nil
}
func (f *fixtureRuntime) Lstat(_ context.Context, p string) (fs.FileInfo, error) {
	if f.missing && strings.HasSuffix(p, "/.nexum-dev") {
		return nil, fs.ErrNotExist
	}
	return fixtureInfo{dir: !strings.HasSuffix(p, "/nexum-agent")}, nil
}
func (f *fixtureRuntime) Run(_ context.Context, c environment.Command) (environment.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(c.Args) < 2 || c.Args[0] != "desktop" {
		return environment.Result{}, errors.New("unexpected command")
	}
	if c.Args[1] == "start" {
		f.starts++
		if f.unknown {
			return environment.Result{Started: true, OutcomeKnown: false}, environment.ErrUnknownOutcome
		}
		f.f.Service = "running"
		f.f.Live = &Live{Protocol: Protocol, Profile: f.f.Profile, Platform: f.f.Platform, Arch: f.f.Arch, Version: f.f.Version, BootID: "boot", AgentID: f.f.AgentID, Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
		f.f.StartAccepted = true
	}
	b, _ := json.Marshal(f.f)
	stdout := string(b)
	if f.progress {
		if c.Progress != nil {
			c.Progress("install_service")
		}
		stdout = environment.DesktopProgressPrefix + "install_service\n" + stdout
	}
	return environment.Result{Stdout: stdout, Started: true, OutcomeKnown: true, ExitCode: 0}, nil
}

type legacyProgressRuntime struct {
	*fixtureRuntime
	detailed, base int
}

func (r *legacyProgressRuntime) Run(ctx context.Context, c environment.Command) (environment.Result, error) {
	for _, a := range c.Args {
		if a == "--runtime-progress" {
			r.detailed++
			return environment.Result{Started: true, OutcomeKnown: true, ExitCode: 2, Stderr: "desktop_management_command_failed\n"}, nil
		}
	}
	r.base++
	return r.fixtureRuntime.Run(ctx, c)
}
func TestLifecycleLegacyProgressFallback(t *testing.T) {
	rt := &legacyProgressRuntime{fixtureRuntime: &fixtureRuntime{f: validTestFacts()}}
	support := true
	o := probe(context.Background(), rt, "development", "https://example.test", "observe", nil, &support)
	if o.Stage != "start" || support || rt.detailed != 1 || rt.base != 1 {
		t.Fatalf("fallback: %+v, supported %v, attempts %d/%d", o, support, rt.detailed, rt.base)
	}
	_ = probe(context.Background(), rt, "development", "https://example.test", "observe", nil, &support)
	if rt.detailed != 1 || rt.base != 2 {
		t.Fatal("old helper was reprobed with unsupported flag")
	}
}
func TestLifecycleRuntimeWaitAndDegradedAdmission(t *testing.T) {
	f := validTestFacts()
	f.Service = "running"
	f.Live = &Live{Protocol: Protocol, Profile: f.Profile, Platform: f.Platform, Arch: f.Arch, Version: f.Version, BootID: "boot", AgentID: f.AgentID, Phase: "running", OriginMatches: true}
	f.RuntimeProgress = &TransferProgress{Stage: "node_download", DownloadedBytes: 5, TotalBytes: 10}
	c := &Controller{}
	s := &session{}
	o := classify(f, testIdentity())
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	if !s.state.WaitingForRuntime || s.state.Summary.Runtime != "degraded" {
		t.Fatalf("expected visible preparation: %+v", s.state)
	}
	s.runtimeWaitSince = time.Now().Add(-runtimeWaitLimit - time.Second)
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	if s.state.WaitingForRuntime || s.state.Summary.Runtime != "degraded" {
		t.Fatal("preparation did not admit degraded control center")
	}
	f.Live.ExecutionReady = true
	f.RuntimeProgress = &TransferProgress{Stage: "ready"}
	o = classify(f, testIdentity())
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	if s.state.WaitingForRuntime || s.state.Summary.Runtime != "healthy" {
		t.Fatal("verified runtime not healthy")
	}
	f.Live.ExecutionReady = false
	f.RuntimeProgress = &TransferProgress{Stage: "host_retry"}
	o = classify(f, testIdentity())
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	if s.state.WaitingForRuntime || s.state.Summary.Runtime != "degraded" {
		t.Fatal("runtime failure should not block management")
	}
}

// A newly bootstrapped supervisor may briefly return no service state even
// though it accepted the start. Model that transition without replaying it.
type delayedServiceRuntime struct {
	*fixtureRuntime
	observations int
}

func (f *delayedServiceRuntime) Run(ctx context.Context, c environment.Command) (environment.Result, error) {
	if len(c.Args) < 2 || c.Args[0] != "desktop" || (c.Args[1] != "start" && c.Args[1] != "observe") {
		return f.fixtureRuntime.Run(ctx, c)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	actual := f.f
	actual.AgentID, actual.AgentName, actual.RequiredVersion = "", "", ""
	actual.Credential, actual.Service, actual.Live = "unknown", "unknown", nil
	if c.Args[1] == "start" {
		f.starts++
		actual.StartAccepted = true
	} else {
		f.observations++
		if f.observations > 1 {
			actual = f.f
			actual.Service = "running"
			actual.AgentName = actual.AgentID // Native observe uses the ID as its fallback.
			actual.Live = &Live{Protocol: Protocol, Profile: actual.Profile, Platform: actual.Platform, Arch: actual.Arch, Version: actual.Version, BootID: "new-boot", AgentID: actual.AgentID, Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
		}
	}
	b, _ := json.Marshal(actual)
	return environment.Result{Stdout: string(b), Started: true, OutcomeKnown: true, ExitCode: 0}, nil
}

func TestStartObservesTransientUnknownServiceWithoutRetry(t *testing.T) {
	rt := &delayedServiceRuntime{fixtureRuntime: &fixtureRuntime{f: validTestFacts()}}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", "https://example.test")
	defer c.Close()
	if _, err := c.Check("local"); err != nil {
		t.Fatal(err)
	}
	initial := awaitStage(t, c, "local", "start", false)
	if _, err := c.Start("local", initial.OperationID, initial.Revision); err != nil {
		t.Fatal(err)
	}
	awaitStage(t, c, "local", "connecting", false)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		state, err := c.Get("local")
		if err == nil && state.Stage == "ready" {
			if state.Summary == nil || state.Summary.AgentID != "agent-test" || state.Summary.Name != "Test Agent" {
				t.Fatalf("incorrect ready identity: %+v", state)
			}
			rt.mu.Lock()
			starts, observations := rt.starts, rt.observations
			rt.mu.Unlock()
			if starts != 1 || observations < 2 {
				t.Fatalf("starts=%d observations=%d", starts, observations)
			}
			return
		}
		if err == nil && (state.Stage == "unknown" || state.Stage == "blocked") {
			t.Fatalf("transient unknown service ended observation: %+v", state)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Agent did not become ready")
}

type repairedServiceRuntime struct {
	*fixtureRuntime
	repaired     bool
	repairCalls  int
	observations int
}

func (f *repairedServiceRuntime) Run(ctx context.Context, c environment.Command) (environment.Result, error) {
	if len(c.Args) < 2 || c.Args[0] != "desktop" {
		return f.fixtureRuntime.Run(ctx, c)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	actual := f.f
	switch c.Args[1] {
	case "repair-service":
		f.repaired = true
		f.repairCalls++
		return environment.Result{Started: true, OutcomeKnown: true, ExitCode: 0}, nil
	case "inspect":
		if f.repaired {
			actual.Service = "unknown"
		}
	case "observe":
		f.observations++
		actual.Service = "unknown"
		if f.observations > 1 {
			actual.Service = "running"
			actual.AgentName = actual.AgentID
			actual.Live = &Live{Protocol: Protocol, Profile: actual.Profile, Platform: actual.Platform, Arch: actual.Arch, Version: actual.Version, BootID: "repair-boot", AgentID: actual.AgentID, Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
		}
	default:
		return environment.Result{}, errors.New("unexpected command")
	}
	b, _ := json.Marshal(actual)
	return environment.Result{Stdout: string(b), Started: true, OutcomeKnown: true, ExitCode: 0}, nil
}

func TestServiceRepairObservesTransientUnknownWithoutRetry(t *testing.T) {
	facts := validTestFacts()
	facts.Service = "missing"
	rt := &repairedServiceRuntime{fixtureRuntime: &fixtureRuntime{f: facts}}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", "https://example.test")
	defer c.Close()
	if _, err := c.Check("local"); err != nil {
		t.Fatal(err)
	}
	initial := awaitStage(t, c, "local", "repair", false)
	if _, err := c.Repair("local", initial.OperationID, initial.Revision); err != nil {
		t.Fatal(err)
	}
	awaitStage(t, c, "local", "connecting", false)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		state, err := c.Get("local")
		if err == nil && state.Stage == "ready" {
			if state.Summary == nil || state.Summary.AgentID != "agent-test" || state.Summary.Name != "Test Agent" {
				t.Fatalf("incorrect repaired identity: %+v", state)
			}
			rt.mu.Lock()
			calls, observations := rt.repairCalls, rt.observations
			rt.mu.Unlock()
			if calls != 1 || observations < 2 {
				t.Fatalf("repairs=%d observations=%d", calls, observations)
			}
			return
		}
		if err == nil && (state.Stage == "unknown" || state.Stage == "blocked") {
			t.Fatalf("transient unknown service ended repair observation: %+v", state)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("repaired Agent did not become ready")
}

func awaitStage(t *testing.T, c *Controller, id, stage string, busy bool) Snapshot {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		s, e := c.Get(id)
		if e == nil && s.Stage == stage && s.Busy == busy {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	s, e := c.Get(id)
	t.Fatalf("state=%+v err=%v want %s busy=%v", s, e, stage, busy)
	return Snapshot{}
}
func TestProbeStripsProgressMarkersFromNativeJSON(t *testing.T) {
	rt := &fixtureRuntime{f: validTestFacts(), progress: true}
	var stages []string
	got := probe(context.Background(), rt, "development", "https://example.test", "inspect", func(stage string) { stages = append(stages, stage) })
	if got.Stage != "start" {
		t.Fatalf("progress marker corrupted native facts: %+v", got)
	}
	found := false
	for _, stage := range stages {
		if stage == "install_service" {
			found = true
		}
	}
	if !found {
		t.Fatalf("progress callback missing: %v", stages)
	}
}

func TestProbeStopRequiresNativeConfirmation(t *testing.T) {
	rt := &fixtureRuntime{f: validTestFacts()}
	rt.f.StopAccepted = true
	rt.f.Service = "stopped"
	rt.f.Live = nil
	got := probe(context.Background(), rt, "development", "https://example.test", "stop", nil)
	if got.Stage != "stopped" || got.Reason != "service_stopped" || got.Facts.StopAccepted != true {
		t.Fatalf("stop was not accepted from native confirmation: %+v", got)
	}
	rt.f.Service = "running"
	if validFacts(rt.f, testIdentity(), "development") {
		t.Fatal("native stop confirmation accepted while service is running")
	}
	rt.f.Service = "stopped"
	rt.f.Live = &Live{Protocol: Protocol, Profile: "development", Platform: "darwin", Arch: "arm64", Version: "1.2.3", BootID: "boot", AgentID: "agent-test", Phase: "running"}
	if validFacts(rt.f, testIdentity(), "development") {
		t.Fatal("native stop confirmation accepted with a live management connection")
	}
}

func TestAcceptedStartRejectsChangedConfiguration(t *testing.T) {
	f := validTestFacts()
	f.StartAccepted = true
	f.Service = "unknown"
	f.Credential = "unknown"
	if !validFacts(f, testIdentity(), "development") {
		t.Fatal("transient unknown service rejected")
	}
	for _, state := range []string{"missing", "unauthorized", "invalid", "mismatch", "unknown"} {
		changed := f
		changed.Config = state
		if validFacts(changed, testIdentity(), "development") {
			t.Fatalf("accepted start with %q configuration", state)
		}
	}
}

func TestControllerFreshCheckAndStart(t *testing.T) {
	rt := &fixtureRuntime{f: validTestFacts()}
	c := New(func(id string) (environment.Runtime, error) {
		if id != "local" {
			return nil, errors.New("missing")
		}
		return rt, nil
	}, "development", "https://example.test")
	defer c.Close()
	if _, e := c.Check("local"); e != nil {
		t.Fatal(e)
	}
	ready := awaitStage(t, c, "local", "start", false)
	if _, e := c.Start("local", ready.OperationID, ready.Revision-1); e == nil {
		t.Fatal("stale revision accepted")
	}
	if _, e := c.Start("local", ready.OperationID, ready.Revision); e != nil {
		t.Fatal(e)
	}
	actual := awaitStage(t, c, "local", "ready", false)
	if actual.Summary == nil || actual.Summary.AgentID != "agent-test" {
		t.Fatal("wrong actual identity")
	}
	if _, e := c.Start("local", ready.OperationID, ready.Revision); e == nil {
		t.Fatal("old start accepted")
	}
	rt.mu.Lock()
	starts := rt.starts
	rt.mu.Unlock()
	if starts != 1 {
		t.Fatalf("start ran %d times", starts)
	}
	// Native's offline observation uses Agent ID as its display-name fallback.
	// Keep the name authenticated by the preceding Cloud inspection.
	rt.mu.Lock()
	rt.f.AgentName = rt.f.AgentID
	rt.mu.Unlock()
	deadline := time.Now().Add(4 * time.Second)
	observed := false
	for time.Now().Before(deadline) {
		state, err := c.Get("local")
		if err == nil && state.Revision > actual.Revision {
			if state.Summary == nil || state.Summary.Name != "Test Agent" {
				t.Fatalf("authenticated name lost after observation: %+v", state)
			}
			observed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("no lifecycle observation received")
	}
	c.Leave("local", actual.OperationID)
	if _, e := c.Get("local"); e == nil {
		t.Fatal("left target retained")
	}
}
func TestControllerUnknownStartDoesNotReplay(t *testing.T) {
	rt := &fixtureRuntime{f: validTestFacts(), unknown: true}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", "https://example.test")
	defer c.Close()
	_, _ = c.Check("local")
	s := awaitStage(t, c, "local", "start", false)
	if _, e := c.Start("local", s.OperationID, s.Revision); e != nil {
		t.Fatal(e)
	}
	after := awaitStage(t, c, "local", "unknown", false)
	if after.Summary != nil {
		t.Fatal("unknown marked ready")
	}
	rt.mu.Lock()
	starts := rt.starts
	rt.mu.Unlock()
	if starts != 1 {
		t.Fatal("unknown start replayed")
	}
}
func TestAuthorizationPKCEAndSingleExchange(t *testing.T) {
	var redirect, state, challenge string
	var exchanges atomic.Int32
	var origin string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/desktop-install/start", func(w http.ResponseWriter, r *http.Request) {
		var v map[string]string
		_ = json.NewDecoder(r.Body).Decode(&v)
		redirect, state, challenge = v["redirectUri"], v["state"], v["codeChallenge"]
		if v["profile"] != "development" || v["purpose"] != "initialize" || v["expectedAgentId"] != "" || v["connection"] != "local" || v["platform"] != "darwin" {
			t.Error("wrong authorization binding")
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(authorizationIntent{RequestID: "request-test", AuthorizationURL: origin + "/auth/desktop-install?request_id=request-test", ExpiresAt: time.Now().Add(time.Minute)})
	})
	mux.HandleFunc("/api/desktop-install/exchange", func(w http.ResponseWriter, r *http.Request) {
		exchanges.Add(1)
		var v map[string]string
		_ = json.NewDecoder(r.Body).Decode(&v)
		sum := sha256.Sum256([]byte(v["codeVerifier"]))
		if base64.RawURLEncoding.EncodeToString(sum[:]) != challenge || v["redirectUri"] != redirect || v["requestId"] != "request-test" {
			t.Error("PKCE binding mismatch")
		}
		_ = json.NewEncoder(w).Encode(credential{AgentID: "fixture-id", Token: "fixture-token", Profile: "development"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	origin = srv.URL
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, e := newAuthorization(ctx, origin, "development", "initialize", "local", "", testIdentity(), "en-US")
	if e != nil {
		t.Fatal(e)
	}
	defer a.close()
	callback := func(st string) int {
		u := redirect + "?" + url.Values{"state": {st}, "code": {"code-fixture-123456"}}.Encode()
		res, e := http.Get(u)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}
	if callback("wrong") != 400 || callback(state) != 200 || callback(state) != 409 {
		t.Fatal("callback state or replay not enforced")
	}
	result, e := a.wait(ctx)
	if e != nil {
		t.Fatal(e)
	}
	cred, e := a.exchange(ctx, result.code)
	if e != nil || cred.AgentID != "fixture-id" {
		t.Fatal("exchange failed", e)
	}
	if _, e = a.exchange(ctx, result.code); e == nil || exchanges.Load() != 1 {
		t.Fatal("exchange replayed")
	}
}

func TestAuthorizationWaitDistinguishesExpiryAndCancellation(t *testing.T) {
	a := &authorization{expires: time.Now().Add(-time.Second), result: make(chan callbackResult, 1)}
	if _, err := a.wait(context.Background()); err == nil || err.Error() != "authorization_expired" {
		t.Fatalf("expired authorization: %v", err)
	}
	a.expires = time.Now().Add(time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.wait(ctx); err == nil || err.Error() != "authorization_cancelled" {
		t.Fatalf("cancelled authorization: %v", err)
	}
}

// A disk preflight must fail closed if the target cannot establish free space.
type diskFixture struct {
	environment.Runtime
	identity environment.Identity
	result   environment.Result
	err      error
}

func (d diskFixture) Identity() environment.Identity { return d.identity }
func (d diskFixture) Run(_ context.Context, cmd environment.Command) (environment.Result, error) {
	return d.result, d.err
}
func TestAuthorizationRestoreCarriesExpectedAgentID(t *testing.T) {
	var origin string
	var received map[string]string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/desktop-install/start", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(authorizationIntent{RequestID: "restore-request", AuthorizationURL: origin + "/auth/desktop-install?request_id=restore-request", ExpiresAt: time.Now().Add(time.Minute)})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	origin = srv.URL
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, err := newAuthorization(ctx, origin, "development", "restore", "local", "agt_expected", testIdentity(), "en-US")
	if err != nil {
		t.Fatal(err)
	}
	defer a.close()
	if received["purpose"] != "restore" || received["expectedAgentId"] != "agt_expected" {
		t.Fatalf("restore target was not bound: %+v", received)
	}
}

func TestInstallSpacePreflight(t *testing.T) {
	for _, tc := range []struct {
		platform, stdout string
		known            bool
		want             string
	}{
		{"darwin", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 1000 100 900 10% /\n", true, ""},
		{"linux", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1000 999 1 99% /\n", true, "install_space_insufficient"},
		{"linux", "unexpected", true, "install_space_unconfirmed"},
		{"windows", "4096", true, ""},
		{"windows", "1024", true, "install_space_insufficient"},
		{"windows", "4096", false, "install_space_unconfirmed"},
	} {
		id := testIdentity()
		id.Platform = tc.platform
		err := checkInstallSpace(context.Background(), diskFixture{identity: id, result: environment.Result{Stdout: tc.stdout, OutcomeKnown: tc.known}}, 1024)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != tc.want {
			t.Errorf("%s: got %q want %q", tc.platform, got, tc.want)
		}
	}
}

func TestLifecycleRecordsOnlyObservedRuntimeStages(t *testing.T) {
	c := &Controller{}
	s := &session{}
	f := validTestFacts()
	f.RuntimeProgress = &TransferProgress{Stage: "node_download", DownloadedBytes: 5, TotalBytes: 10}
	c.publishLocked(s, "install_readiness", "", f, nil)
	c.publishLocked(s, "install_readiness", "", f, nil)
	if got := s.state.ObservedStages; len(got) != 2 || got[0] != "install_readiness" || got[1] != "runtime:node_download" {
		t.Fatalf("observations: %v", got)
	}
	f.RuntimeProgress = &TransferProgress{Stage: "host_start"}
	c.publishLocked(s, "install_readiness", "", f, nil)
	c.publishLocked(s, "failed", "installation_failed", f, nil)
	if s.state.RuntimeProgress != nil || s.state.Progress != nil {
		t.Fatalf("stale failure progress: %+v", s.state)
	}
	if got := s.state.ObservedStages; len(got) != 3 || got[2] != "runtime:host_start" {
		t.Fatalf("history: %v", got)
	}
}
