// Package capabilitywatch contains Desktop-owned capability observation logic.
package capabilitywatch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"
)

// PackageReleaseFacts must come from the selected Agent. Unknown provenance or
// channel is deliberately insufficient to disclose a package name to npm.
type PackageReleaseFacts struct {
	Name             string
	InstalledVersion string
	Registry         string // "public" only when the Agent can establish it
	Channel          string // currently supported npm dist-tags: latest, next
}

type UpdateResult struct {
	Known      bool
	Available  bool
	Version    string
	ObservedAt time.Time
}

type registryEntry struct {
	version string
	at      time.Time
}

type VersionCacheStore interface {
	LoadPublicNPMVersion(key string) (string, time.Time, bool, error)
	SavePublicNPMVersion(key, version string, observedAt time.Time) error
}

// NPMChecker owns its cache and HTTP client. It does not run on the Agent and
// does not accept an endpoint from the WebView, Agent, or npm response.
type NPMChecker struct {
	mu      sync.Mutex
	cache   map[string]registryEntry
	client  *http.Client
	now     func() time.Time
	baseURL string // overridden only by isolated package tests
	store   VersionCacheStore
}

func NewNPMChecker(stores ...VersionCacheStore) *NPMChecker {
	checker := &NPMChecker{
		cache: make(map[string]registryEntry),
		client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("registry_redirect_not_allowed")
		}},
		now: time.Now, baseURL: "https://registry.npmjs.org",
	}
	if len(stores) > 0 {
		checker.store = stores[0]
	}
	return checker
}

var npmName = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`)

// Check returns unknown when provenance or the dist-tag is unverified. A
// failed, cancelled, malformed or redirected request never establishes an
// update and is not cached as a successful observation.
func (c *NPMChecker) Check(ctx context.Context, fact PackageReleaseFacts) (UpdateResult, error) {
	return c.check(ctx, fact, true)
}

// Cached never contacts a registry. It is safe while a detail is being read.
func (c *NPMChecker) Cached(fact PackageReleaseFacts) (UpdateResult, error) {
	return c.check(context.Background(), fact, false)
}

func (c *NPMChecker) check(ctx context.Context, fact PackageReleaseFacts, fetch bool) (UpdateResult, error) {
	if fact.Registry != "public" || (fact.Channel != "latest" && fact.Channel != "next") || len(fact.Name) > 214 || !npmName.MatchString(fact.Name) {
		return UpdateResult{}, nil
	}
	installed, ok := parseVersion(fact.InstalledVersion)
	if !ok {
		return UpdateResult{}, nil
	}
	key := fact.Name + "\x00" + fact.Channel
	digest := sha256.Sum256([]byte(key))
	storageKey := hex.EncodeToString(digest[:])
	c.mu.Lock()
	entry, cached := c.cache[key]
	c.mu.Unlock()
	now := c.now()
	if !cached && c.store != nil {
		version, at, found, err := c.store.LoadPublicNPMVersion(storageKey)
		if _, valid := parseVersion(version); err == nil && found && valid && !now.Before(at) && now.Sub(at) < 24*time.Hour {
			entry, cached = registryEntry{version: version, at: at}, true
			c.mu.Lock()
			c.cache[key] = entry
			c.mu.Unlock()
		}
	}
	if !cached || now.Before(entry.at) || now.Sub(entry.at) >= 24*time.Hour {
		if !fetch {
			return UpdateResult{}, nil
		}
		requestURL := c.baseURL + "/" + url.PathEscape(fact.Name) + "/" + fact.Channel
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
		if err != nil {
			return UpdateResult{}, err
		}
		req.Header.Set("Accept", "application/json")
		resp, err := c.client.Do(req)
		if err != nil {
			return UpdateResult{}, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return UpdateResult{}, fmt.Errorf("registry_http_%d", resp.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024+1))
		if err != nil || len(body) > 64*1024 {
			return UpdateResult{}, errors.New("registry_response_invalid")
		}
		var metadata struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if json.Unmarshal(body, &metadata) != nil || metadata.Name != fact.Name {
			return UpdateResult{}, errors.New("registry_response_invalid")
		}
		if _, ok := parseVersion(metadata.Version); !ok {
			return UpdateResult{}, errors.New("registry_response_invalid")
		}
		if err := ctx.Err(); err != nil {
			return UpdateResult{}, err
		}
		entry = registryEntry{version: metadata.Version, at: c.now()}
		c.mu.Lock()
		c.cache[key] = entry
		c.mu.Unlock()
		if c.store != nil {
			_ = c.store.SavePublicNPMVersion(storageKey, entry.version, entry.at)
		}
	}
	version, _ := parseVersion(entry.version)
	return UpdateResult{Known: true, Available: compareVersion(version, installed) > 0, Version: entry.version, ObservedAt: entry.at}, nil
}
