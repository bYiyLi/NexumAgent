// Package updater owns Desktop release trust and installation transactions.
// It never installs or starts an Agent or reads Agent data.
package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const repository = "bYiyLi/NexumAgent"
const releaseAPI = "https://api.github.com/repos/" + repository + "/releases"
const downloadBase = "https://github.com/" + repository + "/releases/download/"
const manifestName = "update.json"
const signatureName = "update.json.sig"

var ErrTrust = errors.New("untrusted Desktop update")
var ErrNetwork = errors.New("Desktop release service unavailable")
var ErrPermission = errors.New("Desktop installation permission or path")
var ErrRecovery = errors.New("Desktop update recovery required")

// No build metadata is accepted by the existing Desktop release tag contract.
var versionPattern = regexp.MustCompile("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$")

type semanticVersion struct {
	core [3]uint64
	pre  []string
}

func parseVersion(s string) (semanticVersion, error) {
	var v semanticVersion
	m := versionPattern.FindStringSubmatch(s)
	if m == nil {
		return v, fmt.Errorf("invalid Desktop version")
	}
	for i := 0; i < 3; i++ {
		n, err := strconv.ParseUint(m[i+1], 10, 64)
		if err != nil || n > 65535 {
			return v, fmt.Errorf("invalid version component")
		}
		v.core[i] = n
	}
	if m[4] != "" {
		v.pre = strings.Split(m[4], ".")
		for _, p := range v.pre {
			if numeric(p) && len(p) > 1 && p[0] == '0' {
				return v, fmt.Errorf("invalid numeric prerelease")
			}
		}
	}
	return v, nil
}
func numeric(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func compare(a, b semanticVersion) int {
	for i, n := range a.core {
		if n < b.core[i] {
			return -1
		}
		if n > b.core[i] {
			return 1
		}
	}
	if len(a.pre) == 0 && len(b.pre) > 0 {
		return 1
	}
	if len(b.pre) == 0 && len(a.pre) > 0 {
		return -1
	}
	for i, x := range a.pre {
		if i >= len(b.pre) {
			return 1
		}
		y := b.pre[i]
		if x == y {
			continue
		}
		nx, ny := numeric(x), numeric(y)
		if nx && ny {
			if len(x) < len(y) {
				return -1
			}
			if len(x) > len(y) {
				return 1
			}
		}
		if nx && !ny {
			return -1
		}
		if !nx && ny {
			return 1
		}
		return strings.Compare(x, y)
	}
	if len(a.pre) < len(b.pre) {
		return -1
	}
	return 0
}
func CompareVersions(a, b string) (int, error) {
	x, e := parseVersion(a)
	if e != nil {
		return 0, e
	}
	y, e := parseVersion(b)
	if e != nil {
		return 0, e
	}
	return compare(x, y), nil
}
func validChannel(version, profile string) bool {
	v, err := parseVersion(version)
	return err == nil && ((profile == "production" && len(v.pre) == 0) || (profile == "development" && len(v.pre) > 0))
}
func PublicKey(encoded string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: invalid update public key", ErrTrust)
	}
	return ed25519.PublicKey(b), nil
}

type Artifact struct {
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	Name         string `json:"name"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	BinarySHA256 string `json:"binarySha256"`
}
type Manifest struct {
	Format  int        `json:"format"`
	Version string     `json:"version"`
	Profile string     `json:"profile"`
	AppID   string     `json:"appId"`
	Assets  []Artifact `json:"assets"`
}
type SignedManifest struct {
	JSON      []byte `json:"manifest"`
	Signature []byte `json:"signature"`
}

func appIdentity(profile string) (name, appID, exe, prefix string) {
	if profile == "development" {
		return "Nexum Desktop Dev", "com.nexum.desktop.dev", "nexum-desktop-dev", "NexumDesktopDev"
	}
	return "Nexum Desktop", "com.nexum.desktop", "nexum-desktop", "NexumDesktop"
}
func ArtifactName(profile, version, platform, arch string) string {
	_, _, _, prefix := appIdentity(profile)
	suffix := ".dmg"
	if platform == "windows" {
		suffix = "-installer.exe"
	}
	return prefix + "-" + version + "-" + platform + "-" + arch + suffix
}
func hashOK(s string) bool {
	v, e := hex.DecodeString(s)
	return e == nil && len(v) == 32 && s == strings.ToLower(s)
}
func strictJSON(data []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}
func (s SignedManifest) Verify(key ed25519.PublicKey, profile string) (Manifest, error) {
	var m Manifest
	if len(s.JSON) > 256*1024 || len(key) != ed25519.PublicKeySize || len(s.Signature) != ed25519.SignatureSize || !ed25519.Verify(key, s.JSON, s.Signature) {
		return m, fmt.Errorf("%w: manifest signature", ErrTrust)
	}
	if err := strictJSON(s.JSON, &m); err != nil {
		return m, fmt.Errorf("%w: invalid manifest: %v", ErrTrust, err)
	}
	_, appID, _, _ := appIdentity(profile)
	if m.Format != 1 || m.Profile != profile || m.AppID != appID || !validChannel(m.Version, profile) || len(m.Assets) != 4 {
		return m, fmt.Errorf("%w: manifest identity", ErrTrust)
	}
	seen := map[string]bool{}
	for _, a := range m.Assets {
		id := a.OS + "/" + a.Arch
		if seen[id] || (a.OS != "darwin" && a.OS != "windows") || (a.Arch != "arm64" && a.Arch != "amd64") || a.Name != ArtifactName(profile, m.Version, a.OS, a.Arch) || a.Size <= 0 || a.Size > 4*1024*1024*1024 || !hashOK(a.SHA256) || !hashOK(a.BinarySHA256) {
			return m, fmt.Errorf("%w: invalid artifact", ErrTrust)
		}
		seen[id] = true
	}
	return m, nil
}
func (m Manifest) Artifact(platform, arch string) (Artifact, error) {
	for _, a := range m.Assets {
		if a.OS == platform && a.Arch == arch {
			return a, nil
		}
	}
	return Artifact{}, fmt.Errorf("%w: unsupported update platform", ErrTrust)
}

type githubRelease struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}
type Source struct{ client *http.Client }

func allowedHost(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch u.Hostname() {
	case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	}
	return false
}
func NewSource() *Source {
	return &Source{client: &http.Client{
		Timeout: 0, // each check/download has its own context deadline
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 8 || !allowedHost(r.URL) {
				return fmt.Errorf("%w: unexpected download redirect", ErrTrust)
			}
			return nil
		},
	}}
}
func assetURL(version, name string) string {
	return downloadBase + url.PathEscape("desktop/v"+version) + "/" + url.PathEscape(name)
}
func (s *Source) get(ctx context.Context, u string) (*http.Response, error) {
	parsed, err := url.Parse(u)
	if err != nil || !allowedHost(parsed) {
		return nil, fmt.Errorf("%w: unexpected URL", ErrTrust)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "NexumDesktop-Updater")
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := s.client.Do(req)
	if err != nil {
		if errors.Is(err, ErrTrust) {
			return nil, err
		}
		var unknown x509.UnknownAuthorityError
		var host x509.HostnameError
		var invalid x509.CertificateInvalidError
		if errors.As(err, &unknown) || errors.As(err, &host) || errors.As(err, &invalid) {
			return nil, fmt.Errorf("%w: TLS certificate validation failed", ErrTrust)
		}
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500 || res.StatusCode == 404 {
			return nil, fmt.Errorf("%w: HTTP %d", ErrNetwork, res.StatusCode)
		}
		return nil, fmt.Errorf("%w: HTTP %d", ErrTrust, res.StatusCode)
	}
	return res, nil
}
func (s *Source) read(ctx context.Context, u string, max int64) ([]byte, error) {
	r, err := s.get(ctx, u)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%w: release response too large", ErrTrust)
	}
	return b, nil
}

// Discover considers all Desktop tags in the selected channel, not GitHub's
// repository-wide "latest" (Agent releases share this repository).
func (s *Source) Discover(ctx context.Context, profile, current string, key ed25519.PublicKey) (*SignedManifest, error) {
	ctx, cancel := context.WithTimeout(ctx, 18*time.Second)
	defer cancel()
	cv, err := parseVersion(current)
	if err != nil || !validChannel(current, profile) {
		return nil, fmt.Errorf("%w: current version/channel", ErrTrust)
	}
	var selected *githubRelease
	latest := cv
	for page := 1; ; page++ {
		b, e := s.read(ctx, releaseAPI+"?per_page=100&page="+strconv.Itoa(page), 16*1024*1024)
		if e != nil {
			return nil, e
		}
		var releases []githubRelease
		if e = json.Unmarshal(b, &releases); e != nil || releases == nil {
			return nil, fmt.Errorf("%w: invalid release response", ErrTrust)
		}
		for _, r := range releases {
			if r.Draft || !strings.HasPrefix(r.Tag, "desktop/v") {
				continue
			}
			v := strings.TrimPrefix(r.Tag, "desktop/v")
			if !validChannel(v, profile) || r.Prerelease != (profile == "development") {
				continue
			}
			ver, _ := parseVersion(v)
			if compare(ver, latest) > 0 {
				copy := r
				selected = &copy
				latest = ver
			}
		}
		if len(releases) < 100 {
			break
		}
	}
	if selected == nil {
		return nil, nil
	}
	v := strings.TrimPrefix(selected.Tag, "desktop/v")
	assets := map[string]bool{}
	for _, a := range selected.Assets {
		assets[a.Name] = true
	}
	if !assets[manifestName] || !assets[signatureName] {
		return nil, fmt.Errorf("%w: release missing signed manifest", ErrTrust)
	}
	b, e := s.read(ctx, assetURL(v, manifestName), 256*1024)
	if e != nil {
		return nil, fmt.Errorf("%w: manifest unavailable: %v", ErrTrust, e)
	}
	sig, e := s.read(ctx, assetURL(v, signatureName), 256)
	if e != nil {
		return nil, fmt.Errorf("%w: signature unavailable: %v", ErrTrust, e)
	}
	raw, e := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(sig)))
	if e != nil {
		return nil, fmt.Errorf("%w: signature encoding", ErrTrust)
	}
	signed := SignedManifest{JSON: b, Signature: raw}
	m, e := signed.Verify(key, profile)
	if e != nil {
		return nil, e
	}
	if m.Version != v {
		return nil, fmt.Errorf("%w: manifest does not match release", ErrTrust)
	}
	for _, a := range m.Assets {
		if !assets[a.Name] {
			return nil, fmt.Errorf("%w: incomplete release", ErrTrust)
		}
	}
	return &signed, nil
}
