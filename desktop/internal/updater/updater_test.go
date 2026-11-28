package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testConfig(t *testing.T, profile, version string) (Config, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	root := "NexumDesktop"
	if profile == "development" {
		root += "Dev"
	}
	c := Config{Root: filepath.Join(t.TempDir(), root), Profile: profile, Version: version, Key: pub, Enabled: true}
	if e = c.Prepare(); e != nil {
		t.Fatal(e)
	}
	return c, priv
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func signedFixture(t *testing.T, c Config, priv ed25519.PrivateKey, version string, payload []byte) SignedManifest {
	t.Helper()
	_, id, _, _ := appIdentity(c.Profile)
	m := Manifest{Format: 1, Version: version, Profile: c.Profile, AppID: id}
	for _, platform := range []string{"darwin", "windows"} {
		for _, arch := range []string{"arm64", "amd64"} {
			m.Assets = append(m.Assets, Artifact{OS: platform, Arch: arch, Name: ArtifactName(c.Profile, version, platform, arch), Size: int64(len(payload)), SHA256: digest(payload), BinarySHA256: digest([]byte("binary"))})
		}
	}
	b, e := json.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	return SignedManifest{JSON: b, Signature: ed25519.Sign(priv, b)}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(r *http.Request, status int, b []byte) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(b)), ContentLength: int64(len(b)), Header: make(http.Header), Request: r}
}
func TestSemanticVersions(t *testing.T) {
	for _, pair := range [][2]string{{"1.0.0", "1.0.0-next.10"}, {"1.0.0-next.10", "1.0.0-next.9"}, {"1.10.0", "1.9.99"}, {"1.0.0-next.1.2", "1.0.0-next.1"}, {"1.0.0-alpha", "1.0.0-9"}} {
		if n, e := CompareVersions(pair[0], pair[1]); e != nil || n != 1 {
			t.Fatal(pair, n, e)
		}
	}
	for _, v := range []string{"1.01.0", "1.0.0-next.01", "v1.0.0", "1.0.0+foo", "65536.0.0"} {
		if _, e := parseVersion(v); e == nil {
			t.Fatal("invalid version", v)
		}
	}
}
func TestSignedManifestAndDurableRequirement(t *testing.T) {
	c, priv := testConfig(t, "development", "1.0.0-next.1")
	signed := signedFixture(t, c, priv, "1.0.0-next.2", []byte("payload"))
	if _, e := signed.Verify(c.Key, "production"); !errors.Is(e, ErrTrust) {
		t.Fatal("cross channel", e)
	}
	tampered := signed
	tampered.JSON = append([]byte(nil), signed.JSON...)
	tampered.JSON[0] = '['
	if _, e := tampered.Verify(c.Key, c.Profile); !errors.Is(e, ErrTrust) {
		t.Fatal("tampered manifest", e)
	}
	if _, e := c.Require(signed); e != nil {
		t.Fatal(e)
	}
	loaded, e := c.Load()
	if e != nil || loaded == nil || loaded.Phase != "required" {
		t.Fatal(loaded, e)
	}
	if e = c.MarkComplete(loaded); !errors.Is(e, ErrRecovery) {
		t.Fatal("old version bypassed gate", e)
	}
	if _, e = c.Require(signedFixture(t, c, priv, "1.0.0-next.0", []byte("payload"))); !errors.Is(e, ErrTrust) {
		t.Fatal("downgrade", e)
	}
	// Disabling network or changing to a local candidate is not a way to
	// discard a signed requirement; the same on-disk state must still verify.
	local := c
	local.Enabled = false
	local.Key = nil
	if _, e = local.Load(); !errors.Is(e, ErrTrust) {
		t.Fatal("local trust bypass", e)
	}
	source := NewSource()
	source.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
	if _, e = source.Discover(context.Background(), c.Profile, c.Version, c.Key); !errors.Is(e, ErrNetwork) {
		t.Fatal(e)
	}
	if s, e := c.Load(); e != nil || s == nil || !bytes.Equal(s.Required.Signature, signed.Signature) {
		t.Fatal("lost requirement", e)
	}
}
func TestDiscoverySelectsOnlyMatchingDesktopRelease(t *testing.T) {
	c, priv := testConfig(t, "development", "1.0.0-next.1")
	signed := signedFixture(t, c, priv, "1.0.0-next.10", []byte("payload"))
	m, _ := signed.Verify(c.Key, c.Profile)
	assets := []map[string]string{{"name": manifestName}, {"name": signatureName}}
	for _, a := range m.Assets {
		assets = append(assets, map[string]string{"name": a.Name})
	}
	releases := []map[string]any{
		{"tag_name": "v99.0.0", "draft": false, "prerelease": false},
		{"tag_name": "desktop/v3.0.0", "draft": false, "prerelease": false},
		{"tag_name": "desktop/v9.0.0-next.1", "draft": true, "prerelease": true},
		{"tag_name": "desktop/v1.0.0-next.9", "draft": false, "prerelease": true},
		{"tag_name": "desktop/v1.0.0-next.10", "draft": false, "prerelease": true, "assets": assets},
	}
	data, _ := json.Marshal(releases)
	source := NewSource()
	source.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.String(), releaseAPI) {
			return response(r, 200, data), nil
		}
		if r.URL.String() == assetURL(m.Version, manifestName) {
			return response(r, 200, signed.JSON), nil
		}
		if r.URL.String() == assetURL(m.Version, signatureName) {
			return response(r, 200, []byte(base64.StdEncoding.EncodeToString(signed.Signature))), nil
		}
		return nil, fmt.Errorf("unexpected request %s", r.URL)
	})
	got, e := source.Discover(context.Background(), c.Profile, c.Version, c.Key)
	if e != nil || got == nil || !bytes.Equal(got.JSON, signed.JSON) {
		t.Fatal(got, e)
	}
}
func TestDownloadExactBytesAndRejectTampering(t *testing.T) {
	c, priv := testConfig(t, "production", "1.0.0")
	payload := []byte("a complete package")
	signed := signedFixture(t, c, priv, "1.1.0", payload)
	m, _ := signed.Verify(c.Key, c.Profile)
	a, _ := m.Artifact(runtime.GOOS, runtime.GOARCH)
	source := NewSource()
	requests := 0
	source.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) { requests++; return response(r, 200, payload), nil })
	var last, total int64
	path, e := source.Download(context.Background(), c, m, a, func(n, t int64) { last = n; total = t })
	if e != nil || last != a.Size || total != a.Size || verifyFile(path, a) != nil {
		t.Fatal(path, e, last, total)
	}
	if _, e = source.Download(context.Background(), c, m, a, nil); e != nil || requests != 1 {
		t.Fatal("verified cache not reused", e, requests)
	}
	if e = os.WriteFile(path, []byte("bad"), 0600); e != nil {
		t.Fatal(e)
	}
	source.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		return response(r, 200, bytes.Repeat([]byte("x"), len(payload))), nil
	})
	if _, e = source.Download(context.Background(), c, m, a, nil); !errors.Is(e, ErrTrust) {
		t.Fatal("tampered package accepted", e)
	}
	if verifyFile(path, a) == nil {
		t.Fatal("tampered package became installable")
	}
}
func TestUpdateLockAndForeignState(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("Desktop platforms")
	}
	c, priv := testConfig(t, "development", "1.0.0-next.1")
	release, e := c.Lock()
	if e != nil {
		t.Fatal(e)
	}
	if f, e := c.Lock(); e == nil {
		f()
		release()
		t.Fatal("concurrent updater admitted")
	}
	release()
	f, e := c.Lock()
	if e != nil {
		t.Fatal(e)
	}
	f()
	s := signedFixture(t, c, priv, "1.0.0-next.2", []byte("package"))
	if _, e = c.Require(s); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(c.dir(), "state.json")
	if e = os.WriteFile(path, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Load(); e == nil {
		t.Fatal("malformed state silently ignored")
	}
}
