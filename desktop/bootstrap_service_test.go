package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"runtime"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/bYiyLi/NexumAgent/desktop/internal/updater"
)

type fakeReleases struct {
	signed        *updater.SignedManifest
	discoverError error
	downloadError error
	downloads     int
}

func (f *fakeReleases) Discover(context.Context, string, string, ed25519.PublicKey) (*updater.SignedManifest, error) {
	return f.signed, f.discoverError
}
func (f *fakeReleases) Download(ctx context.Context, c updater.Config, m updater.Manifest, a updater.Artifact, p updater.Progress) (string, error) {
	f.downloads++
	if p != nil {
		p(a.Size/2, a.Size)
	}
	return "", f.downloadError
}
func testBoot(t *testing.T) (*FoundationService, *bootstrapController) {
	t.Helper()
	p, e := desktopstate.ResolveAt(t.TempDir(), currentProfile)
	if e != nil {
		t.Fatal(e)
	}
	s := &FoundationService{system: &clientSystem{paths: p, profile: currentProfile}}
	b := newBootstrap(s, p, nil)
	s.bootstrap = b
	t.Cleanup(func() {
		b.stop()
		if s.store != nil {
			s.store.Close()
		}
	})
	return s, b
}
func waitBootstrap(t *testing.T, b *bootstrapController, phase string) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		if b.snapshot().Phase == phase {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("phase %s not observed: %+v", phase, b.snapshot())
}
func TestBootstrapReadyGateAndSafeRetry(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("Desktop platforms")
	}
	s, b := testBoot(t)
	if _, e := s.Info(); e == nil {
		t.Fatal("Info bypassed initialization")
	}
	if e := s.SetTheme("dark"); e == nil {
		t.Fatal("configuration write bypassed gate")
	}
	if _, e := s.Settings(); e == nil {
		t.Fatal("Settings bypassed gate")
	}
	b.openLog = func() error { return errors.New("test path unavailable") }
	if e := b.start(false); e != nil {
		t.Fatal(e)
	}
	waitBootstrap(t, b, "initializationFailed")
	b.workers.Wait()
	if !b.snapshot().Retryable {
		t.Fatal("retry not offered")
	}
	if _, e := s.GetBootstrapState(); e != nil {
		t.Fatal(e)
	}
	b.openLog = nil
	if _, e := s.RetryBootstrap(); e != nil {
		t.Fatal(e)
	}
	waitBootstrap(t, b, "ready")
	if b.snapshot().UpdateCheck != "localBuild" {
		t.Fatal("local build pretended to check release")
	}
	if _, e := s.Info(); e != nil {
		t.Fatal(e)
	}
	if e := s.SetTheme("dark"); e != nil {
		t.Fatal(e)
	}
	if _, e := s.RetryBootstrap(); e == nil {
		t.Fatal("ready bootstrap replayed")
	}
}
func TestBootstrapKnownUpdateSurvivesOfflineRetry(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("Desktop platforms")
	}
	s, b := testBoot(t)
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	profile := string(currentProfile)
	target := "9.0.0"
	if currentProfile == desktopstate.Development {
		target += "-next.1"
	}
	b.config.Enabled = true
	b.config.Key = pub
	// The running version in test builds is the package default. Development
	// release versions are prereleases; the signed target remains valid.
	if currentProfile == desktopstate.Development {
		b.config.Version = version + "-dev"
	}
	sha := sha256.Sum256([]byte("fixture"))
	digest := hex.EncodeToString(sha[:])
	m := updater.Manifest{Format: 1, Version: target, Profile: profile, AppID: currentProfile.AppID()}
	for _, platform := range []string{"darwin", "windows"} {
		for _, arch := range []string{"amd64", "arm64"} {
			m.Assets = append(m.Assets, updater.Artifact{OS: platform, Arch: arch, Name: updater.ArtifactName(profile, target, platform, arch), Size: 8, SHA256: digest, BinarySHA256: digest})
		}
	}
	raw, _ := json.Marshal(m)
	signed := updater.SignedManifest{JSON: raw, Signature: ed25519.Sign(priv, raw)}
	// A verified new release is persisted before downloading, even when the
	// network immediately disappears.
	if _, e = b.config.Require(signed); e != nil {
		t.Fatal(e)
	}
	f := &fakeReleases{discoverError: updater.ErrNetwork, downloadError: errors.New("offline")}
	b.source = f
	if _, e = s.GetBootstrapState(); e != nil {
		t.Fatal(e)
	}
	if e = b.start(false); e != nil {
		t.Fatal(e)
	}
	waitBootstrap(t, b, "failed")
	b.workers.Wait()
	if snap := b.snapshot(); snap.UpdateCheck != "required" || snap.TargetVersion != target || !snap.Retryable {
		t.Fatal(snap)
	}
	if _, e = s.Info(); e == nil {
		t.Fatal("known update bypassed offline")
	}
	if _, e = s.RetryBootstrap(); e != nil {
		t.Fatal(e)
	}
	waitBootstrap(t, b, "failed")
	b.workers.Wait()
	if f.downloads != 2 {
		t.Fatal("retry count", f.downloads)
	}
	if state, e := b.config.Load(); e != nil || state == nil {
		t.Fatal(state, e)
	}
}
