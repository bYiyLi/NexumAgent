// Package environment provides Desktop-owned access to an authenticated OS
// environment. It does not infer Agent installation or expose a generic IPC shell.
package environment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
)

type Identity struct {
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
	Home     string `json:"home"`
	Username string `json:"username"`
}
type Command struct {
	Program  string
	Args     []string
	Dir      string            // absolute path in the target OS; empty means default login directory
	Env      map[string]string // overrides, not secrets
	Stdin    io.Reader
	Progress func(string) // redacted, allowlisted lifecycle progress markers from the child process
}
type Result struct {
	Stdout, Stderr                   string
	ExitCode                         int // -1 if not established
	Started, OutcomeKnown, Truncated bool
}
type Runtime interface {
	Identity() Identity
	Alive() bool
	Run(context.Context, Command) (Result, error)
	Getenv(context.Context, string) (string, error)
	Stat(context.Context, string) (fs.FileInfo, error)
	Lstat(context.Context, string) (fs.FileInfo, error)
	ReadDir(context.Context, string) ([]fs.FileInfo, error)
	MkdirAll(context.Context, string, fs.FileMode) error
	ReadFile(context.Context, string, int64) ([]byte, error)
	WriteFile(context.Context, string, []byte, fs.FileMode) error
	Upload(context.Context, string, string, fs.FileMode) error
	Download(context.Context, string, string, fs.FileMode) error
	Join(string, ...string) (string, error)
	Close() error
}

var ErrDisconnected = errors.New("environment disconnected")
var ErrUnknownOutcome = errors.New("operation outcome unknown; inspect target before retry")
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const outputLimit = 1024 * 1024
const readLimit = 64 * 1024 * 1024

type boundedOutput struct {
	data                []byte
	truncated           bool
	progress            func(string)
	pending             []byte
	discardProgressLine bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	b.scanProgress(p)
	available := outputLimit - len(b.data)
	if available < n {
		b.truncated = true
		p = p[:available]
	}
	b.data = append(b.data, p...)
	return n, nil
}

const DesktopProgressPrefix = "NEXUM_DESKTOP_PROGRESS:"
const desktopProgressPrefix = DesktopProgressPrefix

func validDesktopProgressStage(stage string) bool {
	switch stage {
	case "install_manifest", "install_download", "install_verify", "install_space", "install_stage", "install_config", "install_service", "install_start", "install_readiness",
		"restore_stop", "restore_config", "restore_start", "repair_download", "repair_verify", "repair_apply", "repair_service",
		"start_service", "start_verify", "stop_service", "stop_verify", "maintenance_busy", "reinstall_prepare", "reinstall_apply", "uninstall_service", "uninstall_program":
		return true
	}
	return false
}

// ParseDesktopProgress accepts the bounded byte marker grammar.
// Bytes describe transfer, not integrity or operation success.
func ParseDesktopProgress(marker string) (stage string, downloaded, total int64, ok bool) {
	parts := strings.Split(marker, ":")
	if len(parts) == 1 && validDesktopProgressStage(parts[0]) {
		return parts[0], 0, 0, true
	}
	if len(parts) != 3 || (parts[0] != "install_download" && parts[0] != "repair_download") {
		return "", 0, 0, false
	}
	for _, n := range parts[1:] {
		if n == "" || len(n) > 10 || strings.IndexFunc(n, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return "", 0, 0, false
		}
	}
	done, e1 := strconv.ParseInt(parts[1], 10, 64)
	size, e2 := strconv.ParseInt(parts[2], 10, 64)
	if e1 != nil || e2 != nil || size <= 0 || size > 1<<30 || done < 0 || done > size {
		return "", 0, 0, false
	}
	return parts[0], done, size, true
}

// Runtime markers are emitted only by the verified installer's local observation.
func ParseDesktopRuntimeProgress(marker string) (stage string, downloaded, total int64, ok bool) {
	parts := strings.Split(marker, ":")
	if len(parts) != 4 || parts[0] != "runtime" {
		return "", 0, 0, false
	}
	switch parts[1] {
	case "node_check", "node_download", "node_install", "pnpm_prepare", "host_check", "host_download", "host_install", "host_start", "host_configure", "host_retry", "host_failed", "ready", "unknown":
	default:
		return "", 0, 0, false
	}
	for _, n := range parts[2:] {
		if n == "" || len(n) > 10 || strings.IndexFunc(n, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return "", 0, 0, false
		}
	}
	done, e1 := strconv.ParseInt(parts[2], 10, 64)
	size, e2 := strconv.ParseInt(parts[3], 10, 64)
	if e1 != nil || e2 != nil || done < 0 || size < done || size > 1<<30 || size > 0 && parts[1] != "node_download" && parts[1] != "host_download" {
		return "", 0, 0, false
	}
	return parts[1], done, size, true
}
func validDesktopProgress(marker string) bool {
	_, _, _, ok := ParseDesktopProgress(marker)
	if ok {
		return true
	}
	_, _, _, ok = ParseDesktopRuntimeProgress(marker)
	return ok
}
func (b *boundedOutput) scanProgress(p []byte) {
	if b.progress == nil {
		return
	}
	for _, ch := range p {
		if ch == '\n' {
			if !b.discardProgressLine {
				line := strings.TrimSuffix(string(b.pending), "\r")
				if strings.HasPrefix(line, desktopProgressPrefix) {
					stage := strings.TrimPrefix(line, desktopProgressPrefix)
					if validDesktopProgress(stage) {
						b.progress(stage)
					}
				}
			}
			b.pending = b.pending[:0]
			b.discardProgressLine = false
			continue
		}
		if b.discardProgressLine {
			continue
		}
		if len(b.pending) >= 128 {
			b.pending = b.pending[:0]
			b.discardProgressLine = true
			continue
		}
		b.pending = append(b.pending, ch)
	}
}
func resultFrom(out, errOut boundedOutput) Result {
	return Result{Stdout: string(out.data), Stderr: string(errOut.data), ExitCode: -1, Truncated: out.truncated || errOut.truncated}
}
func validateCommand(c Command) error {
	if c.Program == "" || strings.ContainsRune(c.Program, 0) {
		return errors.New("invalid executable")
	}
	for _, a := range c.Args {
		if strings.ContainsRune(a, 0) {
			return errors.New("invalid argument")
		}
	}
	for k, v := range c.Env {
		if !envName.MatchString(k) || strings.ContainsRune(v, 0) {
			return errors.New("invalid environment override")
		}
	}
	return nil
}
func validateReadLimit(limit int64) error {
	if limit <= 0 || limit > readLimit {
		return errors.New("invalid read limit")
	}
	return nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	return r.r.Read(p)
}
func readBounded(ctx context.Context, r io.Reader, limit int64) ([]byte, error) {
	if e := validateReadLimit(limit); e != nil {
		return nil, e
	}
	data, e := io.ReadAll(io.LimitReader(contextReader{ctx, r}, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(data)) > limit {
		return nil, errors.New("file exceeds read limit")
	}
	return data, ctx.Err()
}

// Target paths are not interpreted with the Desktop host's filepath rules.
func targetPath(platform, p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", errors.New("invalid target path")
	}
	if platform == "windows" {
		p = strings.ReplaceAll(p, "\\", "/")
		if strings.HasPrefix(p, "/") && len(p) > 3 && p[2] == ':' {
			p = p[1:]
		}
		if len(p) < 3 || p[1] != ':' || p[2] != '/' || !((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) {
			return "", errors.New("absolute Windows drive path required")
		}
		return strings.ToUpper(p[:1]) + ":" + path.Clean("/"+p[3:]), nil
	}
	if !strings.HasPrefix(p, "/") {
		return "", errors.New("absolute target path required")
	}
	return path.Clean(p), nil
}
func joinTarget(platform, base string, parts ...string) (string, error) {
	base, e := targetPath(platform, base)
	if e != nil {
		return "", e
	}
	for _, part := range parts {
		if strings.ContainsRune(part, 0) || strings.HasPrefix(part, "/") || platform == "windows" && (strings.Contains(part, ":") || strings.HasPrefix(part, "\\")) {
			return "", errors.New("relative path component required")
		}
		if platform == "windows" {
			part = strings.ReplaceAll(part, "\\", "/")
		}
		base += "/" + part
	}
	return targetPath(platform, base)
}
func posixQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func psQuote(s string) string    { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func unknown(err error) error    { return fmt.Errorf("%w: %w", ErrUnknownOutcome, err) }
