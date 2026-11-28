package lifecycle

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/frontend"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

const callbackPath = "/nexum/desktop/callback"

type credential struct {
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	Token     string `json:"token"`
	Profile   string `json:"profile"`
}
type authorizationIntent struct {
	RequestID        string    `json:"requestId"`
	AuthorizationURL string    `json:"authorizationUrl"`
	ExpiresAt        time.Time `json:"expiresAt"`
}
type callbackResult struct{ code, denial string }
type authorization struct {
	origin, profile, state, verifier, redirect, requestID, authorizationURL string
	language                                                                string
	expires                                                                 time.Time
	listener                                                                net.Listener
	server                                                                  *http.Server
	result                                                                  chan callbackResult
	mu                                                                      sync.Mutex
	accepted                                                                bool
	consumed                                                                bool
}

func randomURLToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
func cloudClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func cloudJSON(ctx context.Context, origin, path string, input, out any, want int) error {
	body, err := json.Marshal(input)
	if err != nil {
		return errors.New("authorization_request_invalid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("authorization_request_invalid")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := cloudClient(15 * time.Second).Do(req)
	if err != nil {
		return errors.New("authorization_outcome_unknown")
	}
	defer resp.Body.Close()
	if resp.StatusCode != want {
		return errors.New("authorization_request_failed")
	}
	if out == nil {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16385))
	if err != nil || len(b) > 16384 || json.Unmarshal(b, out) != nil {
		return errors.New("authorization_outcome_unknown")
	}
	return nil
}
func newAuthorization(ctx context.Context, origin, profile, purpose, targetID, expectedAgentID string, id environment.Identity, language string) (*authorization, error) {
	if (purpose != "initialize" && purpose != "restore") || (profile != "development" && profile != "production") ||
		(purpose == "initialize" && expectedAgentID != "") || (expectedAgentID != "" && !validText(expectedAgentID, 64)) {
		return nil, errors.New("authorization_request_invalid")
	}
	state, err := randomURLToken()
	if err != nil {
		return nil, err
	}
	verifier, err := randomURLToken()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("authorization_listener_unavailable")
	}
	a := &authorization{origin: origin, profile: profile, state: state, verifier: verifier, language: language, listener: ln, result: make(chan callbackResult, 1)}
	a.redirect = "http://" + ln.Addr().String() + callbackPath
	a.server = &http.Server{Handler: http.HandlerFunc(a.callback), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192}
	go func() { _ = a.server.Serve(ln) }()
	digest := sha256.Sum256([]byte(verifier))
	connection := "ssh"
	if targetID == "local" {
		connection = "local"
	}
	var intent authorizationIntent
	err = cloudJSON(ctx, origin, "/api/desktop-install/start", map[string]string{"purpose": purpose, "expectedAgentId": expectedAgentID, "profile": profile, "hostname": id.Hostname, "platform": id.Platform, "arch": id.Arch, "connection": connection, "redirectUri": a.redirect, "state": state, "codeChallenge": base64.RawURLEncoding.EncodeToString(digest[:])}, &intent, http.StatusCreated)
	if err != nil {
		a.close()
		return nil, err
	}
	a.requestID = intent.RequestID
	a.expires = intent.ExpiresAt
	u, err := url.Parse(intent.AuthorizationURL)
	expected, e := url.Parse(origin)
	if err != nil || e != nil || u.Scheme != expected.Scheme || u.Host != expected.Host || u.User != nil || u.Fragment != "" || u.Path != "/auth/desktop-install" || u.RawPath != "" || u.Opaque != "" ||
		len(u.Query()) != 1 || len(u.Query()["request_id"]) != 1 || u.Query().Get("request_id") != intent.RequestID || !validText(intent.RequestID, 256) ||
		!intent.ExpiresAt.After(time.Now()) || intent.ExpiresAt.After(time.Now().Add(11*time.Minute)) {
		a.cancelRequest()
		a.close()
		return nil, errors.New("authorization_response_invalid")
	}
	a.authorizationURL = intent.AuthorizationURL
	return a, nil
}
func (a *authorization) callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host != "127.0.0.1" || r.Host != a.listener.Addr().String() || r.Method != http.MethodGet || r.URL.Path != callbackPath || r.URL.RawPath != "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(a.state)) != 1 || len(q) != 2 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var result callbackResult
	if len(q["code"]) == 1 && len(q.Get("code")) >= 16 && len(q.Get("code")) <= 256 && validText(q.Get("code"), 256) {
		result.code = q.Get("code")
	} else if len(q["error"]) == 1 && q.Get("error") == "access_denied" {
		result.denial = "denied"
	} else {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	if a.accepted {
		a.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.accepted = true
	a.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = frontend.WriteAuthorizationCallback(w, a.language, result.denial == "")
	a.result <- result
}
func (a *authorization) wait(ctx context.Context) (callbackResult, error) {
	wait, cancel := context.WithDeadline(ctx, a.expires)
	defer cancel()
	select {
	case res := <-a.result:
		return res, nil
	case <-wait.Done():
		if ctx.Err() != nil {
			return callbackResult{}, errors.New("authorization_cancelled")
		}
		return callbackResult{}, errors.New("authorization_expired")
	}
}
func (a *authorization) exchange(ctx context.Context, code string) (credential, error) {
	if ctx.Err() != nil || !time.Now().Before(a.expires) {
		return credential{}, errors.New("authorization_expired")
	}
	// Once an exchange has been attempted, never replay it or cancel it as
	// though no Cloud mutation occurred. A lost response is unknown.
	a.mu.Lock()
	if a.consumed {
		a.mu.Unlock()
		return credential{}, errors.New("authorization_outcome_unknown")
	}
	a.consumed = true
	a.mu.Unlock()
	var c credential
	err := cloudJSON(ctx, a.origin, "/api/desktop-install/exchange", map[string]string{"requestId": a.requestID, "code": code, "codeVerifier": a.verifier, "redirectUri": a.redirect}, &c, http.StatusOK)
	if err != nil {
		return credential{}, errors.New("authorization_exchange_unknown")
	}
	if c.Profile != a.profile || !validText(c.AgentID, 256) || !validCredential(c.Token) {
		return credential{}, errors.New("authorization_exchange_unknown")
	}
	return c, nil
}
func validCredential(token string) bool {
	if len(token) == 0 || len(token) > 8192 {
		return false
	}
	for _, c := range token {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}
func (a *authorization) cancelRequest() {
	a.mu.Lock()
	done := a.consumed
	a.mu.Unlock()
	if done || a.requestID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = cloudJSON(ctx, a.origin, "/api/desktop-install/cancel", map[string]string{"requestId": a.requestID, "codeVerifier": a.verifier}, nil, http.StatusNoContent)
}
func (a *authorization) close() { _ = a.server.Close() }
func safeOrigin(s, profile string) bool {
	u, e := url.Parse(s)
	return e == nil && u.Host != "" && u.User == nil && u.Fragment == "" && u.RawQuery == "" && u.Path == "" && u.Opaque == "" &&
		(u.Scheme == "https" || profile == "development" && u.Scheme == "http" && strings.HasPrefix(u.Host, "127.0.0.1:"))
}
