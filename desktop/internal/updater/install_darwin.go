//go:build darwin

package updater

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func tool(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, e := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if e != nil {
		return "", fmt.Errorf("%s: %w: %s", filepath.Base(name), e, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
func bundleOf(binary string) string { return filepath.Dir(filepath.Dir(filepath.Dir(binary))) }
func plistValue(bundle, key string) (string, error) {
	return tool(10*time.Second, "/usr/bin/plutil", "-extract", key, "raw", filepath.Join(bundle, "Contents", "Info.plist"))
}
func checkBundle(c Config, bundle string) (string, error) {
	name, appID, exe, _ := appIdentity(c.Profile)
	if filepath.Base(bundle) != name+".app" {
		return "", fmt.Errorf("%w: unexpected application bundle", ErrPermission)
	}
	info, e := os.Lstat(bundle)
	if e != nil {
		return "", e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%w: unsafe bundle", ErrPermission)
	}
	id, e := plistValue(bundle, "CFBundleIdentifier")
	if e != nil || id != appID {
		return "", fmt.Errorf("%w: bundle identifier", ErrTrust)
	}
	executable, e := plistValue(bundle, "CFBundleExecutable")
	if e != nil || executable != exe {
		return "", fmt.Errorf("%w: bundle executable", ErrTrust)
	}
	binary := filepath.Join(bundle, "Contents", "MacOS", exe)
	canonical, e := filepath.EvalSymlinks(binary)
	if e != nil || canonical != binary {
		return "", fmt.Errorf("%w: unsafe executable path", ErrTrust)
	}
	if _, _, e = fileDigest(binary); e != nil {
		return "", e
	}
	return binary, nil
}
func validateInstallTarget(c Config, binary string) error {
	bundle := bundleOf(binary)
	actual, e := checkBundle(c, bundle)
	if e != nil {
		return e
	}
	if actual != binary {
		return fmt.Errorf("%w: executable not inside Desktop bundle", ErrPermission)
	}
	// App Translocation and mounted, read-only DMGs are manual-install cases.
	if strings.Contains(bundle, "/AppTranslocation/") || strings.HasPrefix(bundle, "/Volumes/") {
		return fmt.Errorf("%w: move Desktop to a writable Applications folder", ErrPermission)
	}
	if e = unix.Access(filepath.Dir(bundle), unix.W_OK); e != nil {
		return fmt.Errorf("%w: %v", ErrPermission, e)
	}
	return nil
}
func codeTeam(bundle string) (string, error) {
	out, e := tool(25*time.Second, "/usr/bin/codesign", "-dv", "--verbose=4", bundle)
	if e != nil {
		return "", e
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "TeamIdentifier=") {
			v := strings.TrimPrefix(line, "TeamIdentifier=")
			if v != "" && v != "not set" {
				return v, nil
			}
		}
	}
	return "", fmt.Errorf("%w: missing Developer ID team", ErrTrust)
}
func verifyBundle(c Config, bundle, source string, a Artifact) error {
	binary, e := checkBundle(c, bundle)
	if e != nil {
		return e
	}
	hash, _, e := fileDigest(binary)
	if e != nil || hash != a.BinarySHA256 {
		return fmt.Errorf("%w: bundle binary hash", ErrTrust)
	}
	if _, e = tool(60*time.Second, "/usr/bin/codesign", "--verify", "--deep", "--strict", bundle); e != nil {
		return fmt.Errorf("%w: %v", ErrTrust, e)
	}
	if c.Profile == "production" {
		oldTeam, e := codeTeam(bundleOf(source))
		if e != nil {
			return e
		}
		newTeam, e := codeTeam(bundle)
		if e != nil || oldTeam != newTeam {
			return fmt.Errorf("%w: different Developer ID team", ErrTrust)
		}
		if _, e = tool(60*time.Second, "/usr/sbin/spctl", "--assess", "--type", "execute", bundle); e != nil {
			return fmt.Errorf("%w: %v", ErrTrust, e)
		}
	}
	return nil
}
func verifyPackage(c Config, source, path string, a Artifact) error {
	if e := verifyFile(path, a); e != nil {
		return e
	}
	if c.Profile == "production" {
		if _, e := tool(60*time.Second, "/usr/bin/codesign", "--verify", "--strict", path); e != nil {
			return fmt.Errorf("%w: %v", ErrTrust, e)
		}
		oldTeam, e := codeTeam(bundleOf(source))
		if e != nil {
			return e
		}
		team, e := codeTeam(path)
		if e != nil || oldTeam != team {
			return fmt.Errorf("%w: disk image publisher mismatch", ErrTrust)
		}
		if _, e = tool(60*time.Second, "/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", path); e != nil {
			return fmt.Errorf("%w: notarization: %v", ErrTrust, e)
		}
	}
	return nil
}
func installPackage(c Config, s State, a Artifact, path string) error {
	// Mount only the verified DMG, read-only, at a unique private mountpoint.
	mount, e := os.MkdirTemp(c.jobDir(s), "mount-")
	if e != nil {
		return e
	}
	mounted := false
	defer func() {
		if !mounted {
			_ = os.Remove(mount)
		}
	}()
	if _, e = tool(90*time.Second, "/usr/bin/hdiutil", "attach", path, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount); e != nil {
		return e
	}
	mounted = true
	defer func() {
		if _, err := tool(30*time.Second, "/usr/bin/hdiutil", "detach", mount); err == nil {
			_ = os.Remove(mount)
		}
	}()
	name, _, _, _ := appIdentity(c.Profile)
	incoming := filepath.Join(mount, name+".app")
	if e = verifyBundle(c, incoming, s.SourceBinary, a); e != nil {
		return e
	}
	oldBundle := bundleOf(s.SourceBinary)
	// Stage on the installed bundle's filesystem; atomic exchange never leaves
	// the installed path missing. Retain the old app until successful startup.
	stage := filepath.Join(filepath.Dir(oldBundle), ".nexum-update-"+s.Transaction)
	if e = os.Mkdir(stage, 0700); e != nil {
		return fmt.Errorf("%w: %v", ErrPermission, e)
	}
	candidate := filepath.Join(stage, name+".app")
	exchanged := false
	defer func() {
		if !exchanged {
			_ = os.RemoveAll(stage)
		}
	}()
	if _, e = tool(180*time.Second, "/usr/bin/ditto", incoming, candidate); e != nil {
		return e
	}
	if e = verifyBundle(c, candidate, s.SourceBinary, a); e != nil {
		return e
	}
	hash, _, e := fileDigest(s.SourceBinary)
	if e != nil || hash != s.SourceSHA256 {
		return fmt.Errorf("%w: source changed", ErrRecovery)
	}
	if e = unix.RenameatxNp(unix.AT_FDCWD, candidate, unix.AT_FDCWD, oldBundle, unix.RENAME_SWAP); e != nil {
		if errors.Is(e, unix.EACCES) || errors.Is(e, unix.EPERM) || errors.Is(e, unix.EROFS) {
			return fmt.Errorf("%w: %v", ErrPermission, e)
		}
		return e
	}
	exchanged = true
	// Stage now holds the exact previous app. Move it into the private
	// transaction when possible; if that fails, keep it on the same volume.
	backup := filepath.Join(c.jobDir(s), "previous.app")
	if e = os.Rename(candidate, backup); e == nil {
		_ = os.Remove(stage)
	}
	return nil
}
func detach(cmd *exec.Cmd) {}
func launchInstalled(c Config, binary string) error {
	_, e := tool(30*time.Second, "/usr/bin/open", bundleOf(binary))
	return e
}
func revealPackage(path string) error {
	_, e := tool(15*time.Second, "/usr/bin/open", "-R", path)
	return e
}
