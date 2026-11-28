package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type artifact struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type manifest struct {
	Version   string     `json:"version"`
	Artifacts []artifact `json:"artifacts"`
}
type installPlan struct {
	version    string
	scriptPath string
	cleanup    func()
	artifact   artifact
}

func validReleaseVersion(v string) bool {
	if len(v) == 0 || len(v) > 80 {
		return false
	}
	suffix, prerelease, hasPrerelease := strings.Cut(v, "-")
	if hasPrerelease {
		for _, p := range strings.Split(prerelease, ".") {
			if p == "" {
				return false
			}
		}
	}
	parts := strings.Split(suffix, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 1 && p[0] == '0' {
			return false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}
func loadReleaseArtifact(ctx context.Context, rt environment.Runtime, origin, profile string, progress func(string)) (string, artifact, error) {
	if !safeOrigin(origin, profile) {
		return "", artifact{}, errors.New("cloud_release_unavailable")
	}
	if progress != nil {
		progress("install_manifest")
	}
	path, cleanup, e := stageTargetDownload(ctx, rt, origin, profile, "/agent/native/manifest.json", "manifest.json", 1<<20)
	if e != nil {
		return "", artifact{}, e
	}
	defer cleanup()
	b, e := rt.ReadFile(ctx, path, 1<<20)
	if e != nil {
		return "", artifact{}, errors.New("target_download_failed")
	}
	var m manifest
	if json.Unmarshal(b, &m) != nil || !validReleaseVersion(m.Version) {
		return "", artifact{}, errors.New("cloud_release_invalid")
	}
	id := rt.Identity()
	name := "nexum-agent-" + id.Platform + "-" + id.Arch
	if id.Platform == "windows" {
		name += ".exe"
	}
	var selected artifact
	count := 0
	for _, a := range m.Artifacts {
		if a.OS == id.Platform && a.Arch == id.Arch {
			selected = a
			count++
		}
	}
	sum, e := hex.DecodeString(selected.SHA256)
	if count != 1 || selected.Name != name || e != nil || len(sum) != sha256.Size || selected.Size <= 0 || selected.Size > 40<<20 {
		return "", artifact{}, errors.New("cloud_release_invalid")
	}
	if progress != nil {
		progress("install_verify")
	}
	return m.Version, selected, nil
}
func prepareInstall(ctx context.Context, rt environment.Runtime, origin, profile string, progress func(string)) (installPlan, error) {
	version, selected, e := loadReleaseArtifact(ctx, rt, origin, profile, progress)
	if e != nil {
		return installPlan{}, e
	}
	id := rt.Identity()
	if progress != nil {
		progress("install_download")
	}
	path := "/agent/install.sh"
	if id.Platform == "windows" {
		path = "/agent/install.ps1"
	}
	name := "install.sh"
	if id.Platform == "windows" {
		name = "install.ps1"
	}
	scriptPath, cleanup, e := stageTargetDownload(ctx, rt, origin, profile, path, name, 512<<10)
	if e != nil {
		return installPlan{}, e
	}
	script, e := rt.ReadFile(ctx, scriptPath, 512<<10)
	if e != nil {
		cleanup()
		return installPlan{}, errors.New("target_download_failed")
	}
	// Old Cloud installers are never invoked with Desktop credentials via
	// argv or Env as a fallback.
	if !strings.Contains(string(script), "# NEXUM_DESKTOP_INSTALL_PROTOCOL=1") {
		cleanup()
		return installPlan{}, errors.New("secure_installer_unavailable")
	}
	return installPlan{version: version, scriptPath: scriptPath, cleanup: cleanup, artifact: selected}, nil
}

// Require enough known space for the staged download and installed native artifact.
// This is a lower bound, not a promise that the Agent's own runtime will fit.
func checkInstallSpace(ctx context.Context, rt environment.Runtime, bytes int64) error {
	id := rt.Identity()
	var cmd environment.Command
	if id.Platform == "windows" {
		home := "'" + strings.ReplaceAll(id.Home, "'", "''") + "'"
		cmd = environment.Command{Program: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; (Get-Item -LiteralPath " + home + ").PSDrive.Free.ToString([Globalization.CultureInfo]::InvariantCulture)"}}
	} else {
		cmd = environment.Command{Program: "df", Args: []string{"-Pk", id.Home}, Env: map[string]string{"LC_ALL": "C"}}
	}
	r, err := rt.Run(ctx, cmd)
	if err != nil || !r.OutcomeKnown || r.Truncated || r.ExitCode != 0 {
		return errors.New("install_space_unconfirmed")
	}
	var free int64
	if id.Platform == "windows" {
		free, err = strconv.ParseInt(strings.TrimSpace(r.Stdout), 10, 64)
	} else {
		lines := strings.Split(strings.TrimSpace(r.Stdout), "\n")
		if len(lines) != 2 {
			return errors.New("install_space_unconfirmed")
		}
		f := strings.Fields(lines[1])
		if len(f) < 6 {
			return errors.New("install_space_unconfirmed")
		}
		free, err = strconv.ParseInt(f[3], 10, 64)
		if err == nil && free >= 0 && free <= (1<<63-1)/1024 {
			free *= 1024
		} else {
			return errors.New("install_space_unconfirmed")
		}
	}
	if err != nil || free < 0 {
		return errors.New("install_space_unconfirmed")
	}
	if free < bytes*2 {
		return errors.New("install_space_insufficient")
	}
	return nil
}
func executeInstall(ctx context.Context, rt environment.Runtime, origin, profile, path, version string, c credential, progress func(string)) error {
	if !validCredential(c.Token) || c.Profile != profile || !rt.Alive() {
		return errors.New("installation_precondition_failed")
	}
	// The token exists only in native memory and a protected process stdin.
	input := strings.NewReader(origin + "\n" + c.Token + "\n")
	var cmd environment.Command
	if rt.Identity().Platform == "windows" {
		cmd = environment.Command{Program: "powershell.exe", Args: []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, "-Profile", profile, "-DesktopStdin", "-ExpectedVersion", version}, Stdin: input, Progress: progress}
	} else {
		cmd = environment.Command{Program: "/bin/sh", Args: []string{path, "--profile", profile, "--desktop-stdin", "--expected-version", version}, Stdin: input, Progress: progress}
	}
	r, e := rt.Run(ctx, cmd)
	if e != nil || !r.OutcomeKnown || r.Truncated {
		return errors.New("installation_outcome_unknown")
	}
	if r.ExitCode != 0 {
		return errors.New("installation_not_confirmed")
	}
	return nil
}
func executeRestore(ctx context.Context, rt environment.Runtime, origin, profile string, c credential, progress func(string)) error {
	path, _, reason := programPath(ctx, rt, profile)
	if reason != "" || path == "" || !validCredential(c.Token) || c.Profile != profile {
		return errors.New("restore_precondition_failed")
	}
	// The owning Native executable performs configuration validation and
	// atomic write; Desktop never opens the Agent config itself.
	r, e := rt.Run(ctx, environment.Command{Program: path, Args: []string{"desktop", "restore", "--profile", profile, "--server", origin, "--agent-id", c.AgentID}, Stdin: strings.NewReader(c.Token + "\n"), Progress: progress})
	if e != nil || !r.OutcomeKnown || r.Truncated || r.ExitCode != 0 {
		return errors.New("restore_outcome_unknown")
	}
	return nil
}
