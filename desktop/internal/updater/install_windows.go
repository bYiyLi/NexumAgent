//go:build windows

package updater

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func windowsTool(name string) (string, error) {
	root, e := windows.GetSystemDirectory()
	if e != nil {
		return "", e
	}
	return filepath.Join(root, name), nil
}
func validateInstallTarget(c Config, binary string) error {
	name, _, exe, _ := appIdentity(c.Profile)
	// Existing installer is deliberately per-user and profile-specific.
	local := os.Getenv("LOCALAPPDATA")
	expected := filepath.Join(local, "Programs", name, exe+".exe")
	if !filepath.IsAbs(local) || !strings.EqualFold(binary, expected) {
		return fmt.Errorf("%w: use the installed per-user Desktop", ErrPermission)
	}
	canonical, e := filepath.EvalSymlinks(expected)
	if e != nil || !strings.EqualFold(canonical, binary) {
		return fmt.Errorf("%w: redirected install path", ErrPermission)
	}
	if _, _, e = fileDigest(binary); e != nil {
		return e
	}
	return nil
}
func signatureSubject(path string) (string, error) {
	// Get-AuthenticodeSignature uses Windows trust verification. A constant
	// script receives the path via an environment variable, never interpolation.
	ps, e := windowsTool(filepath.Join("WindowsPowerShell", "v1.0", "powershell.exe"))
	if e != nil {
		return "", e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ps, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$s=Get-AuthenticodeSignature -LiteralPath $env:NEXUM_VERIFY_FILE; if ($s.Status -ne 'Valid' -or -not $s.SignerCertificate) { exit 12 }; [Console]::Write($s.SignerCertificate.Subject)")
	cmd.Env = append(os.Environ(), "NEXUM_VERIFY_FILE="+path)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, e := cmd.CombinedOutput()
	if e != nil || strings.TrimSpace(string(out)) == "" {
		return "", fmt.Errorf("%w: Authenticode validation: %v", ErrTrust, e)
	}
	return strings.TrimSpace(string(out)), nil
}
func verifyPackage(c Config, source, path string, a Artifact) error {
	if e := verifyFile(path, a); e != nil {
		return e
	}
	if c.Profile == "production" {
		expected, e := signatureSubject(source)
		if e != nil {
			return e
		}
		actual, e := signatureSubject(path)
		if e != nil || actual != expected {
			return fmt.Errorf("%w: installer publisher mismatch", ErrTrust)
		}
	}
	return nil
}
func installPackage(c Config, s State, a Artifact, path string) error {
	if e := validateInstallTarget(c, s.SourceBinary); e != nil {
		return e
	}
	hash, _, e := fileDigest(s.SourceBinary)
	if e != nil || hash != s.SourceSHA256 {
		return fmt.Errorf("%w: source changed after exit", ErrRecovery)
	}
	backup := filepath.Join(c.jobDir(s), "previous.exe")
	if e := copyFile(s.SourceBinary, backup, 0600); e != nil {
		return e
	}
	if e := verifyPackage(c, s.SourceBinary, path, a); e != nil {
		return e
	}
	// The signed installer owns the per-user install path. Do not use /D or
	// allow a path from an external response. Never kill it mid-install.
	cmd := exec.Command(path, "/S")
	cmd.Dir = c.jobDir(s)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if e := cmd.Run(); e != nil {
		return fmt.Errorf("%w: NSIS install failed: %v", ErrRecovery, e)
	}
	hash, _, e = fileDigest(s.SourceBinary)
	if e != nil || hash != a.BinarySHA256 {
		return fmt.Errorf("%w: installed binary mismatch", ErrRecovery)
	}
	if c.Profile == "production" {
		before, e := signatureSubject(backup)
		if e != nil {
			return e
		}
		after, e := signatureSubject(s.SourceBinary)
		if e != nil || before != after {
			return fmt.Errorf("%w: installed publisher mismatch", ErrTrust)
		}
	}
	return nil
}
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
}
func launchInstalled(c Config, binary string) error {
	cmd := exec.Command(binary)
	cmd.Dir = filepath.Dir(binary)
	detach(cmd)
	if e := cmd.Start(); e != nil {
		return e
	}
	return cmd.Process.Release()
}
func revealPackage(path string) error {
	explorer, e := windows.GetWindowsDirectory()
	if e != nil {
		return e
	}
	cmd := exec.Command(filepath.Join(explorer, "explorer.exe"), "/select,"+path)
	if e = cmd.Start(); e != nil {
		return e
	}
	return cmd.Process.Release()
}
