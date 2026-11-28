package environment

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Local struct{ identity Identity }

func NewLocal() *Local {
	hostname, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	username := ""
	if u, e := user.Current(); e == nil {
		username = u.Username
	}
	return &Local{Identity{Hostname: hostname, Platform: runtime.GOOS, Arch: runtime.GOARCH, Home: home, Username: username}}
}
func (l *Local) Identity() Identity { return l.identity }
func (l *Local) Alive() bool        { return true }
func (l *Local) Close() error       { return nil }
func (l *Local) Join(base string, parts ...string) (string, error) {
	return joinTarget(l.identity.Platform, base, parts...)
}
func (l *Local) Run(ctx context.Context, c Command) (Result, error) {
	r := Result{ExitCode: -1}
	if e := validateCommand(c); e != nil {
		return r, e
	}
	if c.Dir != "" {
		if _, e := targetPath(l.identity.Platform, c.Dir); e != nil {
			return r, e
		}
	}
	cmd := exec.CommandContext(ctx, c.Program, c.Args...)
	// Bound output-pipe waits when a descendant inherits the descriptors.
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir = c.Dir
	if cmd.Dir == "" {
		cmd.Dir = l.identity.Home
	}
	cmd.Stdin = c.Stdin
	if len(c.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range c.Env {
			filtered := cmd.Env[:0]
			for _, entry := range cmd.Env {
				name, _, _ := strings.Cut(entry, "=")
				equal := name == k
				if runtime.GOOS == "windows" {
					equal = strings.EqualFold(name, k)
				}
				if !equal {
					filtered = append(filtered, entry)
				}
			}
			cmd.Env = append(filtered, k+"="+v)
		}
	}
	var out, errOut boundedOutput
	out.progress = c.Progress
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if e := cmd.Start(); e != nil {
		return r, e
	}
	e := cmd.Wait()
	r = resultFrom(out, errOut)
	r.Started = true
	if ctx.Err() != nil {
		return r, unknown(ctx.Err())
	}
	r.OutcomeKnown = true
	if e == nil {
		r.ExitCode = 0
		return r, nil
	}
	var exit *exec.ExitError
	if errors.As(e, &exit) && exit.ExitCode() >= 0 {
		r.ExitCode = exit.ExitCode()
		return r, nil
	}
	r.OutcomeKnown = false
	return r, unknown(e)
}
func (l *Local) Getenv(ctx context.Context, k string) (string, error) {
	if e := ctx.Err(); e != nil {
		return "", e
	}
	if !envName.MatchString(k) {
		return "", errors.New("invalid variable name")
	}
	return os.Getenv(k), nil
}
func (l *Local) native(p string) (string, error) { return targetPath(l.identity.Platform, p) }
func (l *Local) Stat(ctx context.Context, p string) (fs.FileInfo, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	p, e := l.native(p)
	if e != nil {
		return nil, e
	}
	return os.Stat(p)
}
func (l *Local) Lstat(ctx context.Context, p string) (fs.FileInfo, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	p, e := l.native(p)
	if e != nil {
		return nil, e
	}
	return os.Lstat(p)
}
func (l *Local) ReadDir(ctx context.Context, p string) ([]fs.FileInfo, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	p, e := l.native(p)
	if e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(p)
	if e != nil {
		return nil, e
	}
	result := make([]fs.FileInfo, 0, len(entries))
	for _, entry := range entries {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		i, e := entry.Info()
		if e != nil {
			return nil, e
		}
		result = append(result, i)
	}
	return result, nil
}
func (l *Local) MkdirAll(ctx context.Context, p string, mode fs.FileMode) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	p, e := l.native(p)
	if e != nil {
		return e
	}
	return os.MkdirAll(p, mode.Perm())
}
func (l *Local) ReadFile(ctx context.Context, p string, limit int64) ([]byte, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	p, e := l.native(p)
	if e != nil {
		return nil, e
	}
	f, e := os.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	return readBounded(ctx, f, limit)
}

// Write through a sibling temporary file. Existing destination is untouched
// until all bytes have been copied and synced.
func writeLocal(ctx context.Context, p string, r io.Reader, mode fs.FileMode) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".nexum-write-*")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	defer f.Close()
	if e = f.Chmod(mode.Perm()); e != nil {
		return e
	}
	if _, e = io.Copy(f, contextReader{ctx, r}); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	return os.Rename(tmp, p)
}
func (l *Local) WriteFile(ctx context.Context, p string, data []byte, mode fs.FileMode) error {
	p, e := l.native(p)
	if e != nil {
		return e
	}
	return writeLocal(ctx, p, bytes.NewReader(data), mode)
}
func (l *Local) Upload(ctx context.Context, from, to string, mode fs.FileMode) error {
	if !filepath.IsAbs(from) {
		return errors.New("absolute local source required")
	}
	to, e := l.native(to)
	if e != nil {
		return e
	}
	f, e := os.Open(from)
	if e != nil {
		return e
	}
	defer f.Close()
	return writeLocal(ctx, to, f, mode)
}
func (l *Local) Download(ctx context.Context, from, to string, mode fs.FileMode) error {
	if !filepath.IsAbs(to) {
		return errors.New("absolute local destination required")
	}
	from, e := l.native(from)
	if e != nil {
		return e
	}
	f, e := os.Open(from)
	if e != nil {
		return e
	}
	defer f.Close()
	return writeLocal(ctx, to, f, mode)
}
