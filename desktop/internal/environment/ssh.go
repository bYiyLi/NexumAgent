package environment

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

type SSHConfig struct {
	Host               string
	Port               int
	Username, AuthType string
}
type Secret struct {
	Password   string `json:"password,omitempty"`
	KeyPath    string `json:"keyPath,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}
type ConnectionError struct{ Code string }

func (e *ConnectionError) Error() string { return e.Code }
func failure(code string) error          { return &ConnectionError{code} }
func ErrorCode(err error) string {
	var e *ConnectionError
	if errors.As(err, &e) {
		return e.Code
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "connection_failed"
}

func normalizeHost(host string) (string, error) {
	host = strings.TrimSpace(host)
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String(), nil
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if len(host) == 0 || len(host) > 253 {
		return "", failure("invalid_host")
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", failure("invalid_host")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", failure("invalid_host")
			}
		}
	}
	return host, nil
}
func NormalizeConfig(c SSHConfig) (SSHConfig, error) {
	h, e := normalizeHost(c.Host)
	if e != nil {
		return c, e
	}
	c.Host = h
	if c.Port < 1 || c.Port > 65535 {
		return c, failure("invalid_port")
	}
	if len(c.Username) == 0 || len(c.Username) > 128 || strings.ContainsAny(c.Username, "/@") || strings.IndexFunc(c.Username, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return c, failure("invalid_user")
	}
	if c.AuthType != "password" && c.AuthType != "key" && c.AuthType != "agent" {
		return c, failure("invalid_auth")
	}
	return c, nil
}
func validateSecret(c SSHConfig, s Secret) error {
	if len(s.Password) > 4096 || len(s.Passphrase) > 4096 || len(s.KeyPath) > 4096 {
		return failure("invalid_credentials")
	}
	if c.AuthType == "password" && s.Password == "" {
		return failure("credentials_required")
	}
	if c.AuthType == "key" && s.KeyPath == "" {
		return failure("credentials_required")
	}
	return nil
}
func privateSigner(s Secret) (ssh.Signer, error) {
	info, e := os.Lstat(s.KeyPath)
	if e != nil || !info.Mode().IsRegular() {
		return nil, failure("key_unavailable")
	}
	f, e := os.Open(s.KeyPath)
	if e != nil {
		return nil, failure("key_unavailable")
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > 1024*1024 {
		return nil, failure("key_unavailable")
	}
	data, e := readBounded(context.Background(), f, 1024*1024)
	if e != nil {
		return nil, failure("key_unavailable")
	}
	defer clear(data)
	signer, e := ssh.ParsePrivateKey(data)
	var missing *ssh.PassphraseMissingError
	if errors.As(e, &missing) {
		if s.Passphrase == "" {
			return nil, failure("key_passphrase_required")
		}
		pass := []byte(s.Passphrase)
		defer clear(pass)
		signer, e = ssh.ParsePrivateKeyWithPassphrase(data, pass)
	}
	if e != nil {
		return nil, failure("key_invalid")
	}
	return signer, nil
}

type SSH struct {
	identity Identity
	client   *ssh.Client
	files    *sftp.Client
	closed   atomic.Bool
}

// Dial performs host key verification during the SSH transport handshake,
// before password/public-key authentication. The verifier must explicitly
// accept the exact observed host key or reject it; no insecure callback exists.
func Dial(ctx context.Context, c SSHConfig, secret Secret, verify func(ssh.PublicKey) error) (*SSH, error) {
	c, e := NormalizeConfig(c)
	if e != nil {
		return nil, e
	}
	if verify == nil {
		return nil, failure("host_verifier_required")
	}
	if e = validateSecret(c, secret); e != nil {
		return nil, e
	}
	var auth ssh.AuthMethod
	var authErr error
	var localAgent net.Conn
	var stopAgent func() bool
	switch c.AuthType {
	case "password":
		auth = ssh.Password(secret.Password)
	case "key":
		signer, e := privateSigner(secret)
		if e != nil {
			return nil, e
		}
		auth = ssh.PublicKeys(signer)
	case "agent":
		// Open the system agent only when the SSH protocol requests user auth.
		auth = ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			localAgent, e = openSSHAgent(ctx)
			if e != nil {
				authErr = failure("ssh_agent_unavailable")
				return nil, authErr
			}
			if deadline, ok := ctx.Deadline(); ok {
				_ = localAgent.SetDeadline(deadline)
			}
			conn := localAgent
			stopAgent = context.AfterFunc(ctx, func() { _ = conn.Close() })
			signers, err := agent.NewClient(localAgent).Signers()
			if err != nil || len(signers) == 0 {
				authErr = failure("ssh_agent_unavailable")
				return nil, authErr
			}
			return signers, nil
		})
	}
	defer func() {
		if stopAgent != nil {
			stopAgent()
		}
		if localAgent != nil {
			_ = localAgent.Close()
		}
	}()
	var hostErr error
	var acceptedKey ssh.PublicKey
	cfg := &ssh.ClientConfig{User: c.Username, Auth: []ssh.AuthMethod{auth}, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if acceptedKey != nil {
			if ssh.FingerprintSHA256(acceptedKey) != ssh.FingerprintSHA256(key) {
				return failure("host_changed")
			}
			return nil
		}
		hostErr = verify(key)
		if hostErr == nil {
			acceptedKey = key
		}
		return hostErr
	}}
	endpoint := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	raw, e := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", endpoint)
	if e != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, failure("network")
	}
	success := false
	defer func() {
		if !success {
			_ = raw.Close()
		}
	}()
	deadline := time.Now().Add(2 * time.Minute)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = raw.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	conn, chans, reqs, e := ssh.NewClientConn(raw, endpoint, cfg)
	if e != nil {
		if hostErr != nil {
			return nil, hostErr
		}
		if authErr != nil {
			return nil, authErr
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if strings.Contains(e.Error(), "unable to authenticate") {
			return nil, failure("auth_failed")
		}
		return nil, failure("handshake_failed")
	}
	client := ssh.NewClient(conn, chans, reqs)
	runtime := &SSH{client: client}
	// Probe only OS identity; never inspect Agent files/configuration here.
	identity, e := runtime.probe(ctx)
	if e != nil {
		_ = runtime.Close()
		return nil, e
	}
	runtime.identity = identity
	runtime.files, e = sftp.NewClient(client)
	if e != nil {
		_ = runtime.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, failure("sftp_unavailable")
	}
	if ctx.Err() != nil {
		_ = runtime.Close()
		return nil, ctx.Err()
	}
	if !stop() {
		_ = runtime.Close()
		return nil, ctx.Err()
	}
	_ = raw.SetDeadline(time.Time{})
	success = true
	done := make(chan struct{})
	go func() { _ = client.Wait(); runtime.closed.Store(true); close(done) }()
	go runtime.keepalive(done)
	return runtime, nil
}

// A reply (including a rejected request) proves the transport is live.
func (s *SSH) keepalive(done <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			stop, err := s.guard(ctx)
			if err != nil {
				cancel()
				return
			}
			_, _, err = s.client.SendRequest("keepalive@openssh.com", true, nil)
			stop()
			cancel()
			if err != nil {
				_ = s.Close()
				return
			}
		}
	}
}
func (s *SSH) Identity() Identity { return s.identity }
func (s *SSH) Alive() bool        { return s != nil && !s.closed.Load() }
func (s *SSH) Close() error {
	if s == nil {
		return nil
	}
	if s.closed.Swap(true) {
		return nil
	}
	return s.client.Close()
}
func (s *SSH) Join(base string, parts ...string) (string, error) {
	return joinTarget(s.identity.Platform, base, parts...)
}

// Cancellation closes this connection rather than claiming the remote process
// was terminated. All in-flight operations on that connection may be unknown.
func (s *SSH) guard(ctx context.Context) (func(), error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if !s.Alive() {
		return nil, ErrDisconnected
	}
	stop := context.AfterFunc(ctx, func() { _ = s.Close() })
	return func() { stop() }, nil
}
func (s *SSH) runRaw(ctx context.Context, cmd string, stdinReader interface{ Read([]byte) (int, error) }) (Result, error) {
	return s.runRawProgress(ctx, cmd, stdinReader, nil)
}
func (s *SSH) runRawProgress(ctx context.Context, cmd string, stdinReader interface{ Read([]byte) (int, error) }, progress func(string)) (Result, error) {
	result := Result{ExitCode: -1}
	done, e := s.guard(ctx)
	if e != nil {
		return result, e
	}
	defer done()
	session, e := s.client.NewSession()
	if e != nil {
		return result, e
	}
	defer session.Close()
	var out, errOut boundedOutput
	out.progress = progress
	session.Stdout = &out
	session.Stderr = &errOut
	session.Stdin = stdinReader
	e = session.Start(cmd)
	if e != nil {
		r := resultFrom(out, errOut)
		return r, unknown(e)
	}
	e = session.Wait()
	result = resultFrom(out, errOut)
	result.Started = true
	if ctx.Err() != nil {
		return result, unknown(ctx.Err())
	}
	if e == nil {
		result.ExitCode = 0
		result.OutcomeKnown = true
		return result, nil
	}
	var exit *ssh.ExitError
	if errors.As(e, &exit) && exit.ExitStatus() >= 0 {
		result.ExitCode = exit.ExitStatus()
		result.OutcomeKnown = true
		return result, nil
	}
	return result, unknown(e)
}
func powershell(script string) string {
	units := utf16.Encode([]rune("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " + script))
	data := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(data[i*2:], u)
	}
	return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
}
func cleanIdentity(v string) bool {
	return v != "" && len(v) <= 4096 && strings.IndexFunc(v, unicode.IsControl) < 0
}
func archName(s string) string {
	switch strings.ToLower(s) {
	case "x86_64", "amd64", "x64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	}
	return ""
}
func (s *SSH) probe(ctx context.Context) (Identity, error) {
	r, e := s.runRaw(ctx, "uname -s && uname -m && hostname && printf '%s\\n' \"$HOME\" && id -un", nil)
	if e == nil && r.OutcomeKnown && r.ExitCode == 0 && !r.Truncated {
		lines := strings.Split(strings.TrimSpace(r.Stdout), "\n")
		if len(lines) == 5 {
			platform := strings.ToLower(strings.TrimSpace(lines[0]))
			arch := archName(strings.TrimSpace(lines[1]))
			home := strings.TrimSuffix(lines[3], "\r")
			host := strings.TrimSpace(lines[2])
			user := strings.TrimSpace(lines[4])
			if (platform == "darwin" || platform == "linux") && arch != "" && cleanIdentity(host) && cleanIdentity(home) && cleanIdentity(user) && strings.HasPrefix(home, "/") {
				return Identity{Hostname: host, Platform: platform, Arch: arch, Home: home, Username: user}, nil
			}
		}
	}
	if ctx.Err() != nil {
		return Identity{}, ctx.Err()
	}
	if e != nil {
		return Identity{}, failure("connection_failed")
	}
	r, e = s.runRaw(ctx, powershell("$ErrorActionPreference='Stop'; $a=$env:PROCESSOR_ARCHITEW6432; if (!$a) {$a=$env:PROCESSOR_ARCHITECTURE}; [Console]::WriteLine('windows'); [Console]::WriteLine($a); [Console]::WriteLine([Environment]::MachineName); [Console]::WriteLine($HOME); [Console]::WriteLine([Environment]::UserName)"), nil)
	if e == nil && r.OutcomeKnown && r.ExitCode == 0 && !r.Truncated {
		lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(r.Stdout), "\r\n", "\n"), "\n")
		if len(lines) == 5 && lines[0] == "windows" {
			arch := archName(lines[1])
			home := lines[3]
			if arch != "" && cleanIdentity(lines[2]) && cleanIdentity(home) && cleanIdentity(lines[4]) {
				if _, e := targetPath("windows", home); e == nil {
					return Identity{Hostname: lines[2], Platform: "windows", Arch: arch, Home: home, Username: lines[4]}, nil
				}
			}
		}
	}
	return Identity{}, failure("unsupported_environment")
}
func sortedEnv(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Quote according to the Windows CommandLineToArgvW/MS C runtime rules. The
// encoded PowerShell wrapper passes this command line through ProcessStartInfo,
// not PowerShell's legacy native argument parser.
func windowsArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\r\n\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, c := range s {
		if c == '\\' {
			slashes++
			continue
		}
		if c == '"' {
			b.WriteString(strings.Repeat("\\", slashes*2+1))
			b.WriteRune(c)
		} else {
			b.WriteString(strings.Repeat("\\", slashes))
			b.WriteRune(c)
		}
		slashes = 0
	}
	b.WriteString(strings.Repeat("\\", slashes*2))
	b.WriteByte('"')
	return b.String()
}
func remoteCommand(platform string, c Command) (string, error) {
	if e := validateCommand(c); e != nil {
		return "", e
	}
	if c.Dir != "" {
		if _, e := targetPath(platform, c.Dir); e != nil {
			return "", e
		}
	}
	if platform == "windows" {
		args := make([]string, len(c.Args))
		for i, a := range c.Args {
			args[i] = windowsArg(a)
		}
		// Windows SSH servers may use cmd or PowerShell as their default shell.
		// The wrapper is ASCII and all user-supplied values are encoded literals.
		script := "$ErrorActionPreference='Stop'; $p=New-Object System.Diagnostics.ProcessStartInfo; $p.UseShellExecute=$false; $p.FileName=" + psQuote(c.Program) + "; $p.Arguments=" + psQuote(strings.Join(args, " ")) + ";"
		if c.Dir != "" {
			script += "$p.WorkingDirectory=" + psQuote(c.Dir) + ";"
		}
		for _, k := range sortedEnv(c.Env) {
			script += "$p.EnvironmentVariables[" + psQuote(k) + "]=" + psQuote(c.Env[k]) + ";"
		}
		script += "$proc=[Diagnostics.Process]::Start($p); $proc.WaitForExit(); exit $proc.ExitCode"
		return powershell(script), nil
	}
	if platform != "darwin" && platform != "linux" {
		return "", failure("unsupported_environment")
	}
	var args []string
	if c.Dir != "" {
		args = append(args, "cd "+posixQuote(c.Dir)+" || exit $?;")
	}
	args = append(args, "exec", "env", "--")
	for _, k := range sortedEnv(c.Env) {
		args = append(args, posixQuote(k+"="+c.Env[k]))
	}
	args = append(args, posixQuote(c.Program))
	for _, a := range c.Args {
		args = append(args, posixQuote(a))
	}
	return strings.Join(args, " "), nil
}
func (s *SSH) Run(ctx context.Context, c Command) (Result, error) {
	command, e := remoteCommand(s.identity.Platform, c)
	if e != nil {
		return Result{ExitCode: -1}, e
	}
	return s.runRawProgress(ctx, command, c.Stdin, c.Progress)
}
func (s *SSH) Getenv(ctx context.Context, k string) (string, error) {
	if !envName.MatchString(k) {
		return "", errors.New("invalid variable name")
	}
	command := "printf '%s' \"$" + k + "\""
	if s.identity.Platform == "windows" {
		command = powershell("[Console]::Write([Environment]::GetEnvironmentVariable(" + psQuote(k) + "))")
	}
	r, e := s.runRaw(ctx, command, nil)
	if e != nil {
		return "", e
	}
	if !r.OutcomeKnown || r.ExitCode != 0 || r.Truncated {
		return "", fmt.Errorf("environment query failed")
	}
	return r.Stdout, nil
}
