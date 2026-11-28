package capabilitywatch

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type testVersionCache struct{ values map[string]registryEntry }

func (s *testVersionCache) LoadPublicNPMVersion(key string) (string, time.Time, bool, error) {
	v, ok := s.values[key]
	return v.version, v.at, ok, nil
}
func (s *testVersionCache) SavePublicNPMVersion(key, version string, at time.Time) error {
	s.values[key] = registryEntry{version: version, at: at}
	return nil
}

func TestNPMCheckerRequiresVerifiedPublicSourceAndChannel(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.EscapedPath() != "/@example%2Fbrowser/next" {
			t.Errorf("unexpected path %q", r.URL.EscapedPath())
		}
		_, _ = fmt.Fprint(w, `{"name":"@example/browser","version":"2.0.0-rc.2"}`)
	}))
	defer server.Close()
	checker := NewNPMChecker()
	checker.baseURL = server.URL
	now := time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC)
	checker.now = func() time.Time { return now }
	fact := PackageReleaseFacts{Name: "@example/browser", InstalledVersion: "2.0.0-rc.1", Registry: "public", Channel: "next"}
	for _, patch := range []func(*PackageReleaseFacts){
		func(f *PackageReleaseFacts) { f.Registry = "private" },
		func(f *PackageReleaseFacts) { f.Registry = "unknown" },
		func(f *PackageReleaseFacts) { f.Channel = "" },
		func(f *PackageReleaseFacts) { f.Name = "../../private" },
		func(f *PackageReleaseFacts) { f.InstalledVersion = "invalid" },
	} {
		invalid := fact
		patch(&invalid)
		got, err := checker.Check(context.Background(), invalid)
		if err != nil || got.Known {
			t.Fatalf("unverified fact produced a result: %+v %v", got, err)
		}
	}
	if requests != 0 {
		t.Fatalf("unverified source triggered %d requests", requests)
	}
	got, err := checker.Check(context.Background(), fact)
	if err != nil || !got.Known || !got.Available || got.Version != "2.0.0-rc.2" || !got.ObservedAt.Equal(now) {
		t.Fatalf("update = %+v, %v", got, err)
	}
	now = now.Add(23 * time.Hour)
	if _, err = checker.Check(context.Background(), fact); err != nil || requests != 1 {
		t.Fatalf("cache missed: %d %v", requests, err)
	}
	now = now.Add(time.Hour)
	if _, err = checker.Check(context.Background(), fact); err != nil || requests != 2 {
		t.Fatalf("cache did not expire: %d %v", requests, err)
	}
}

func TestNPMCheckerRejectsUntrustedResponseAndRedirect(t *testing.T) {
	mode, requests := "wrong-name", 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch mode {
		case "wrong-name":
			_, _ = fmt.Fprint(w, `{"name":"another","version":"1.0.1"}`)
		case "oversize":
			_, _ = fmt.Fprint(w, strings.Repeat("x", 64*1024+1))
		case "redirect":
			http.Redirect(w, r, "https://example.invalid/", http.StatusFound)
		case "ok":
			_, _ = fmt.Fprint(w, `{"name":"pkg","version":"1.0.1"}`)
		}
	}))
	defer server.Close()
	checker := NewNPMChecker()
	checker.baseURL = server.URL
	fact := PackageReleaseFacts{Name: "pkg", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"}
	for _, mode = range []string{"wrong-name", "oversize", "redirect"} {
		got, err := checker.Check(context.Background(), fact)
		if err == nil || got.Known {
			t.Fatalf("%s accepted: %+v %v", mode, got, err)
		}
	}
	mode = "ok"
	got, err := checker.Check(context.Background(), fact)
	if err != nil || !got.Available || requests != 4 {
		t.Fatalf("failures cached or update missing: %+v %v, requests=%d", got, err, requests)
	}
}

func TestSemverPrecedence(t *testing.T) {
	ordered := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"}
	for i, raw := range ordered {
		v, ok := parseVersion(raw)
		if !ok {
			t.Fatalf("invalid %q", raw)
		}
		for j, other := range ordered {
			w, _ := parseVersion(other)
			got := compareVersion(v, w)
			if (i < j && got >= 0) || (i == j && got != 0) || (i > j && got <= 0) {
				t.Fatalf("%q vs %q = %d", raw, other, got)
			}
		}
	}
	for _, raw := range []string{"v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0+", strings.Repeat("1", 257)} {
		if _, ok := parseVersion(raw); ok {
			t.Fatalf("accepted %q", raw)
		}
	}
	a, _ := parseVersion("999999999999999999999.0.0+one")
	b, _ := parseVersion("2.0.0+two")
	if compareVersion(a, b) <= 0 {
		t.Fatal("large numeric precedence overflowed")
	}
}

func TestPublicNPMCacheSurvivesCheckerRestart(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = fmt.Fprint(w, `{"name":"pkg","version":"2.0.0"}`)
	}))
	defer server.Close()
	store := &testVersionCache{values: map[string]registryEntry{}}
	now := time.Date(2026, 11, 28, 0, 0, 0, 0, time.UTC)
	fact := PackageReleaseFacts{Name: "pkg", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"}
	for i := 0; i < 2; i++ {
		checker := NewNPMChecker(store)
		checker.baseURL = server.URL
		checker.now = func() time.Time { return now }
		got, err := checker.Check(context.Background(), fact)
		if err != nil || !got.Available {
			t.Fatalf("check %d: %+v %v", i, got, err)
		}
	}
	if requests != 1 {
		t.Fatalf("restart made %d requests", requests)
	}
}
