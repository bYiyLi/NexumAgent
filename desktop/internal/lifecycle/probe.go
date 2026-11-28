// Package lifecycle owns the Desktop-side Agent lifecycle state machine.
// It consumes the authenticated OS Runtime and the Agent-owned redacted CLI.
// It must never open Agent config.json, SQLite, logs or private readiness files.
package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strings"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

const Protocol = 1

type Live struct {
	Protocol       int    `json:"protocol"`
	Profile        string `json:"profile"`
	Version        string `json:"version"`
	Platform       string `json:"platform"`
	Arch           string `json:"arch"`
	BootID         string `json:"bootId"`
	AgentID        string `json:"agentId"`
	Phase          string `json:"phase"`
	OriginMatches  bool   `json:"originMatches"`
	CloudOnline    bool   `json:"cloudOnline"`
	ExecutionReady bool   `json:"executionReady"`
	TargetVersion  string `json:"targetVersion,omitempty"`
}

// TransferProgress contains optional verified observations of actual transfer.
type TransferProgress struct {
	Stage           string `json:"stage"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
}

func validRuntimeProgress(p *TransferProgress, live *Live) bool {
	if p == nil {
		return true
	}
	if live == nil || !live.OriginMatches || live.BootID == "" {
		return false
	}
	if !oneOf(p.Stage, "node_check", "node_download", "node_install", "pnpm_prepare", "host_check", "host_download", "host_install", "host_start", "host_configure", "host_retry", "host_failed", "ready", "unknown", "agent_upgrade_download", "agent_upgrade_verify", "agent_upgrade_apply") {
		return false
	}
	if p.TotalBytes < 0 || p.TotalBytes > 1<<30 || p.DownloadedBytes < 0 || p.DownloadedBytes > p.TotalBytes {
		return false
	}
	if strings.HasPrefix(p.Stage, "agent_upgrade_") && live.Phase != "upgrading" {
		return false
	}
	if p.Stage == "ready" && !live.ExecutionReady {
		return false
	}
	if p.TotalBytes != 0 && !oneOf(p.Stage, "node_download", "host_download", "agent_upgrade_download") {
		return false
	}
	return true
}

type Facts struct {
	Protocol        int               `json:"protocol"`
	Profile         string            `json:"profile"`
	Platform        string            `json:"platform"`
	Arch            string            `json:"arch"`
	Version         string            `json:"version"`
	Root            string            `json:"root"`
	Program         string            `json:"program"`
	Config          string            `json:"config"`
	Credential      string            `json:"credential"`
	Service         string            `json:"service"`
	RequiredVersion string            `json:"requiredVersion"`
	AgentID         string            `json:"agentId"`
	AgentName       string            `json:"agentName"`
	RuntimeProgress *TransferProgress `json:"runtimeProgress,omitempty"`
	Live            *Live             `json:"live,omitempty"`
	StartAccepted   bool              `json:"startAccepted"`
	StopAccepted    bool              `json:"stopAccepted"`
}
type Summary struct {
	Name       string `json:"name"`
	AgentID    string `json:"agentId"`
	BootID     string `json:"bootId"`
	Platform   string `json:"platform"`
	Arch       string `json:"arch"`
	Version    string `json:"version"`
	Runtime    string `json:"runtime"`
	Management string `json:"management"`
	Cloud      string `json:"cloud"`
}
type Outcome struct {
	Stage   string
	Reason  string
	Facts   Facts
	Summary *Summary
}

func outcome(stage, reason string, f Facts) Outcome {
	return Outcome{Stage: stage, Reason: reason, Facts: f}
}
func oneOf(s string, allowed ...string) bool {
	for _, a := range allowed {
		if a == s {
			return true
		}
	}
	return false
}
func validText(v string, n int) bool {
	return v != "" && len(v) <= n && !strings.ContainsAny(v, "\x00\r\n")
}
func validFacts(f Facts, id environment.Identity, profile string) bool {
	if f.Protocol != Protocol || f.Profile != profile || f.Platform != id.Platform || f.Arch != id.Arch ||
		!oneOf(f.Root, "present", "missing", "unsafe", "unknown") || !oneOf(f.Program, "present", "missing", "invalid", "unknown") ||
		!oneOf(f.Config, "valid", "missing", "unauthorized", "invalid", "mismatch", "unknown") ||
		!oneOf(f.Credential, "valid", "missing", "invalid", "unknown") ||
		!oneOf(f.Service, "running", "starting", "stopped", "missing", "invalid", "unknown") {
		return false
	}
	if (f.StartAccepted || f.StopAccepted) && f.Program != "present" {
		return false
	}
	if f.StartAccepted && (f.Root != "present" || f.Config != "valid" || !oneOf(f.Credential, "valid", "unknown")) {
		return false
	}
	if f.StopAccepted && (f.Service != "stopped" || f.Live != nil || f.StartAccepted) {
		return false
	}
	if f.StartAccepted && !oneOf(f.Service, "running", "starting", "stopped", "unknown") {
		return false
	}
	if f.Program == "present" && !validText(f.Version, 128) {
		return false
	}
	if f.AgentID != "" && !validText(f.AgentID, 256) || f.AgentName != "" && !validText(f.AgentName, 512) || f.RequiredVersion != "" && !validText(f.RequiredVersion, 128) {
		return false
	}
	if f.Live != nil {
		l := f.Live
		if l.Protocol != Protocol || l.Profile != profile || l.Platform != id.Platform || l.Arch != id.Arch ||
			!validText(l.Version, 128) || !oneOf(l.Phase, "starting", "running", "upgrading", "stopping") ||
			(l.Phase == "running" && (!validText(l.AgentID, 256) || !validText(l.BootID, 256))) {
			return false
		}
	}
	return true
}
func classify(f Facts, id environment.Identity) Outcome {
	if f.Root == "missing" {
		return outcome("initialize", "not_installed", f)
	}
	if f.Root != "present" {
		return outcome("blocked", "unsafe_or_unknown_directory", f)
	}
	if f.Program == "missing" || f.Program == "invalid" {
		if f.Program == "missing" {
			return outcome("repair", "program_missing", f)
		}
		return outcome("blocked", "program_invalid", f)
	}
	if f.Program != "present" {
		return outcome("unknown", "management_protocol_unavailable", f)
	}
	if f.Config == "invalid" || f.Config == "mismatch" {
		return outcome("blocked", "configuration", f)
	}
	if f.Service == "invalid" {
		return outcome("blocked", "service_identity_unconfirmed", f)
	}
	if f.Service == "missing" {
		if f.Config == "valid" && f.Credential == "valid" && f.Live == nil {
			return outcome("repair", "service_missing", f)
		}
		if oneOf(f.Config, "unauthorized", "missing") && f.AgentID != "" && f.Live == nil {
			return outcome("configure", "credential_missing_or_invalid", f)
		}
		if f.Config == "valid" && oneOf(f.Credential, "invalid", "missing") && f.Live == nil {
			return outcome("configure", "credential_missing_or_invalid", f)
		}
		return outcome("blocked", "service_identity_unconfirmed", f)
	}
	if f.Service == "unknown" && (f.Config == "unauthorized" || f.Config == "missing" || f.Credential == "invalid") {
		return outcome("blocked", "service_identity_unconfirmed", f)
	}
	if f.Config == "unauthorized" || f.Config == "missing" || f.Credential == "invalid" {
		return outcome("configure", "credential_missing_or_invalid", f)
	}
	if f.Config != "valid" {
		return outcome("unknown", "configuration_unknown", f)
	}
	if f.Live != nil {
		l := f.Live
		if !l.OriginMatches {
			return outcome("blocked", "management_identity_mismatch", f)
		}
		if f.AgentID != "" && l.AgentID != "" && f.AgentID != l.AgentID {
			return outcome("blocked", "management_identity_mismatch", f)
		}
		if l.Phase == "upgrading" {
			return outcome("upgrade", "agent_upgrading", f)
		}
		if l.Phase == "stopping" || l.Phase == "starting" {
			return outcome("connecting", "waiting_for_management", f)
		}
		if l.Phase == "running" && f.Service == "running" {
			if f.RequiredVersion != "" && l.Version != f.RequiredVersion {
				return outcome("upgrade", "version_incompatible", f)
			}
			if l.Version != f.Version {
				return outcome("connecting", "version_changed", f)
			}
			name := f.AgentName
			if name == "" {
				name = id.Hostname
			}
			health := "degraded"
			if l.ExecutionReady {
				health = "healthy"
			}
			cloud := "offline"
			if l.CloudOnline {
				cloud = "online"
			}
			return Outcome{Stage: "ready", Reason: "management_verified", Facts: f, Summary: &Summary{Name: name, AgentID: l.AgentID, BootID: l.BootID, Platform: id.Platform, Arch: id.Arch, Version: l.Version, Runtime: health, Management: "connected", Cloud: cloud}}
		}
		// Never assume a stopped or unknown service if a live instance responds.
		return outcome("unknown", "service_identity_unconfirmed", f)
	}
	if f.Service == "stopped" {
		if f.Credential == "valid" {
			return outcome("start", "service_stopped", f)
		}
		return outcome("network", "credential_unconfirmed", f)
	}
	if f.Service == "running" || f.Service == "starting" {
		if f.Credential == "valid" && f.RequiredVersion != "" && f.Version != f.RequiredVersion {
			return outcome("upgrade", "version_incompatible", f)
		}
		return outcome("connecting", "waiting_for_management", f)
	}
	return outcome("unknown", "service_identity_unconfirmed", f)
}
func programPath(ctx context.Context, rt environment.Runtime, profile string) (string, Facts, string) {
	id := rt.Identity()
	f := Facts{Protocol: Protocol, Profile: profile, Platform: id.Platform, Arch: id.Arch, Root: "unknown", Program: "unknown", Config: "unknown", Credential: "unknown", Service: "unknown"}
	if !oneOf(id.Platform, "darwin", "linux", "windows") || !oneOf(id.Arch, "amd64", "arm64") || !validText(id.Home, 4096) || !validText(id.Username, 512) || !validText(id.Hostname, 512) {
		return "", f, "unsupported_environment"
	}
	if !rt.Alive() {
		return "", f, "environment_disconnected"
	}
	folder := ".nexum"
	if profile == "development" {
		folder = ".nexum-dev"
	}
	root, err := rt.Join(id.Home, folder)
	if err != nil {
		return "", f, "unsafe_or_unknown_directory"
	}
	info, err := rt.Lstat(ctx, root)
	if errors.Is(err, fs.ErrNotExist) {
		f.Root = "missing"
		return "", f, ""
	}
	if err != nil {
		return "", f, "directory_unconfirmed"
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 || id.Platform != "windows" && info.Mode().Perm()&0077 != 0 {
		f.Root = "unsafe"
		return "", f, "unsafe_or_unknown_directory"
	}
	f.Root = "present"
	bin, err := rt.Join(root, "bin")
	if err != nil {
		return "", f, "directory_unconfirmed"
	}
	bi, err := rt.Lstat(ctx, bin)
	if errors.Is(err, fs.ErrNotExist) {
		legacy := "nexum-agent"
		if id.Platform == "windows" {
			legacy += ".exe"
		}
		lp, _ := rt.Join(root, legacy)
		if _, le := rt.Lstat(ctx, lp); le == nil || !errors.Is(le, fs.ErrNotExist) {
			return "", f, "legacy_installation_unconfirmed"
		}
		f.Program = "missing"
		return "", f, ""
	}
	if err != nil {
		return "", f, "directory_unconfirmed"
	}
	if !bi.IsDir() || bi.Mode()&fs.ModeSymlink != 0 || id.Platform != "windows" && bi.Mode().Perm()&0022 != 0 {
		return "", f, "unsafe_or_unknown_directory"
	}
	name := "nexum-agent"
	if id.Platform == "windows" {
		name += ".exe"
	}
	program, err := rt.Join(bin, name)
	if err != nil {
		return "", f, "directory_unconfirmed"
	}
	pi, err := rt.Lstat(ctx, program)
	if errors.Is(err, fs.ErrNotExist) {
		f.Program = "missing"
		return "", f, ""
	}
	if err != nil {
		return "", f, "program_unconfirmed"
	}
	if !pi.Mode().IsRegular() || pi.Mode()&fs.ModeSymlink != 0 || id.Platform != "windows" && (pi.Mode().Perm()&0022 != 0 || pi.Mode().Perm()&0100 == 0) {
		return "", f, "unsafe_program"
	}
	return program, f, ""
}
func probe(ctx context.Context, rt environment.Runtime, profile, origin, command string, phase func(string), runtimeSupport ...*bool) Outcome {
	if phase != nil {
		phase("system")
	}
	if !rt.Alive() {
		return outcome("network", "environment_disconnected", Facts{})
	}
	if phase != nil {
		phase("conditions")
		phase("directory")
	}
	program, f, reason := programPath(ctx, rt, profile)
	if reason != "" {
		stage := "unknown"
		if reason == "unsupported_environment" || reason == "unsafe_or_unknown_directory" || reason == "unsafe_program" {
			stage = "blocked"
		}
		if reason == "environment_disconnected" {
			stage = "network"
		}
		return outcome(stage, reason, f)
	}
	if program == "" {
		return classify(f, rt.Identity())
	}
	if phase != nil {
		phase("program")
	}
	args := []string{"desktop", command, "--profile", profile, "--server", origin}
	// Only read-only inspections negotiate detail. Never replay mutations.
	detailed := oneOf(command, "inspect", "observe") && (len(runtimeSupport) == 0 || *runtimeSupport[0])
	call := func(arguments []string) (environment.Result, error) {
		return rt.Run(ctx, environment.Command{Program: program, Args: arguments, Progress: phase})
	}
	var res environment.Result
	var err error
	if detailed {
		res, err = call(append(append([]string(nil), args...), "--runtime-progress"))
		if err == nil && res.OutcomeKnown && !res.Truncated && res.ExitCode == 2 &&
			strings.TrimSpace(res.Stderr) == "desktop_management_command_failed" {
			if len(runtimeSupport) > 0 {
				*runtimeSupport[0] = false
			}
			res, err = call(args)
		}
	} else {
		res, err = call(args)
	}
	if err != nil || !res.OutcomeKnown || res.Truncated {
		return outcome("unknown", "operation_outcome_unknown", f)
	}
	if res.ExitCode != 0 {
		return outcome("unknown", "management_protocol_unavailable", f)
	}
	// Strict wire decoder: versioned, bounded and no accidental secret fields.
	var output strings.Builder
	for _, line := range strings.Split(res.Stdout, "\n") {
		if !strings.HasPrefix(line, environment.DesktopProgressPrefix) {
			output.WriteString(line)
			output.WriteByte('\n')
		}
	}
	d := json.NewDecoder(strings.NewReader(output.String()))
	d.DisallowUnknownFields()
	var actual Facts
	if d.Decode(&actual) != nil || !validFacts(actual, rt.Identity(), profile) {
		return outcome("unknown", "management_protocol_unavailable", f)
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return outcome("unknown", "management_protocol_unavailable", f)
	}
	// Optional detail must not invalidate verified base facts.
	if !validRuntimeProgress(actual.RuntimeProgress, actual.Live) {
		actual.RuntimeProgress = nil
	}
	if command == "start" && actual.StartAccepted && actual.Live == nil && oneOf(actual.Service, "stopped", "starting", "running", "unknown") {
		return outcome("connecting", "waiting_for_management", actual)
	}
	if command == "stop" && actual.StopAccepted && actual.Service == "stopped" && actual.Live == nil {
		return outcome("stopped", "service_stopped", actual)
	}
	if phase != nil {
		phase("config")
		phase("service")
		phase("version")
	}
	return classify(actual, rt.Identity())
}
