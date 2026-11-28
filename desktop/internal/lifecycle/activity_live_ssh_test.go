package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// activitySSHGate stops one activity request after its path checks so the
// acceptance test can sever the actual SSH connection at a known point.
type activitySSHGate struct {
	environment.Runtime
	entered chan struct{}
	release chan struct{}
}

func (g *activitySSHGate) Run(ctx context.Context, command environment.Command) (environment.Result, error) {
	if g.entered != nil && len(command.Args) > 1 && command.Args[0] == "desktop" && command.Args[1] == "activity" {
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return environment.Result{}, ctx.Err()
		}
	}
	return g.Runtime.Run(ctx, command)
}

// This opt-in acceptance test uses the current user's existing loopback SSH
// configuration and development Agent. It neither stores a Desktop target nor
// executes a Run; the retained history is read-only.
func TestActivityLiveLoopbackSSH(t *testing.T) {
	if os.Getenv("NEXUM_TEST_ACTIVITY_LOOPBACK_SSH") != "1" {
		t.Skip("requires an explicitly selected local SSH acceptance environment")
	}
	origin := os.Getenv("NEXUM_TEST_ACTIVITY_DEV_ORIGIN")
	if origin == "" {
		t.Fatal("development origin is required")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal("cannot determine the local account home")
	}
	configOutput, err := exec.Command("ssh", "-G", "localhost").Output()
	if err != nil {
		t.Fatal("cannot read the existing loopback SSH configuration")
	}
	settings := map[string]string{}
	for _, line := range strings.Split(string(configOutput), "\n") {
		key, value, ok := strings.Cut(line, " ")
		if ok && settings[key] == "" {
			settings[key] = strings.TrimSpace(value)
		}
	}
	host := settings["hostname"]
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		t.Fatal("acceptance SSH target must be loopback")
	}
	port, err := strconv.Atoi(settings["port"])
	if err != nil || settings["user"] == "" || settings["identityfile"] == "" {
		t.Fatal("incomplete loopback SSH configuration")
	}
	expand := func(value string) string {
		if value == "~" {
			return home
		}
		if strings.HasPrefix(value, "~/") {
			return filepath.Join(home, value[2:])
		}
		return value
	}
	keyPath := expand(settings["identityfile"])
	var files []string
	for _, name := range strings.Fields(settings["userknownhostsfile"]) {
		name = expand(name)
		if info, err := os.Stat(name); err == nil && info.Mode().IsRegular() {
			files = append(files, name)
		}
	}
	if len(files) == 0 {
		t.Fatal("no existing known-hosts file is available")
	}
	hostCheck, err := knownhosts.New(files...)
	if err != nil {
		t.Fatal("cannot load existing SSH host keys")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	remote, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatal("cannot resolve loopback SSH")
	}
	verify := func(key ssh.PublicKey) error { return hostCheck(address, remote, key) }
	dial := func(ctx context.Context) *environment.SSH {
		t.Helper()
		rt, err := environment.Dial(ctx, environment.SSHConfig{Host: host, Port: port, Username: settings["user"], AuthType: "key"},
			environment.Secret{KeyPath: keyPath}, verify)
		if err != nil {
			t.Fatalf("verified loopback SSH failed: %s", environment.ErrorCode(err))
		}
		return rt
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	localAgent := filepath.Join(home, ".nexum-dev", "bin", "nexum-agent")
	observe, err := exec.CommandContext(ctx, localAgent, "desktop", "observe", "--profile", "development", "--server", origin).Output()
	if err != nil {
		t.Fatal("development Agent observation failed")
	}
	var observed struct {
		Profile string `json:"profile"`
		Live    *struct {
			AgentID string `json:"agentId"`
			BootID  string `json:"bootId"`
			Phase   string `json:"phase"`
		} `json:"live"`
	}
	if json.Unmarshal(observe, &observed) != nil || observed.Profile != "development" || observed.Live == nil ||
		observed.Live.Phase != "running" || observed.Live.AgentID == "" || observed.Live.BootID == "" {
		t.Fatal("development Agent identity is not ready")
	}
	agent, boot := observed.Live.AgentID, observed.Live.BootID
	newController := func(rt environment.Runtime, operation string) *Controller {
		c := New(func(id string) (environment.Runtime, error) {
			if id != "ssh-acceptance" {
				return nil, environment.ErrDisconnected
			}
			return rt, nil
		}, "development", origin)
		sessionCtx, sessionCancel := context.WithCancel(ctx)
		c.current = &session{id: "ssh-acceptance", operation: operation, rt: rt, ctx: sessionCtx, cancel: sessionCancel,
			state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: agent, BootID: boot}}}
		t.Cleanup(c.Close)
		return c
	}
	rt := dial(ctx)
	t.Cleanup(func() { _ = rt.Close() })
	gate := &activitySSHGate{Runtime: rt}
	c := newController(gate, "first")
	list, err := c.Activity("ssh-acceptance", "first", agent, boot, "list", "", "", "", 0)
	if err != nil || list.Activity.List == nil {
		t.Fatal("real SSH activity list failed")
	}
	var selected *ActivityRun
	for i := range list.Activity.List.Runs {
		run := &list.Activity.List.Runs[i]
		if run.Status == "succeeded" && run.Availability != nil && run.Availability.Code && run.Availability.Input && run.Availability.Logs {
			selected = run
			break
		}
	}
	if selected == nil {
		t.Skip("no completed development Run with all three retained snapshots")
	}
	detail, err := c.Activity("ssh-acceptance", "first", agent, boot, "detail", selected.RunID, "", "", 0)
	if err != nil || detail.Activity.Detail == nil || detail.Activity.Detail.Run.RunID != selected.RunID {
		t.Fatal("real SSH activity detail failed")
	}
	for _, kind := range []string{"code", "input", "logs"} {
		part, err := c.Activity("ssh-acceptance", "first", agent, boot, "part", selected.RunID, "", kind, 0)
		if err != nil || part.Activity.Part == nil {
			t.Fatalf("real SSH %s snapshot failed", kind)
		}
		args := []string{"desktop", "activity", "--profile", "development", "--server", origin, "--agent-id", agent, "--boot-id", boot,
			"--activity-action", "part", "--run-id", selected.RunID, "--part", kind, "--offset", "0", "--max-bytes", "16384"}
		output, err := exec.CommandContext(ctx, localAgent, args...).Output()
		var local struct {
			Activity ActivityResponse `json:"activity"`
		}
		if err != nil || json.Unmarshal(output, &local) != nil || !reflect.DeepEqual(part.Activity.Part, local.Activity.Part) {
			t.Fatalf("SSH and Local %s snapshots differ", kind)
		}
	}

	gate.entered, gate.release = make(chan struct{}), make(chan struct{})
	type readResult struct {
		snapshot ActivitySnapshot
		err      error
	}
	readDone := make(chan readResult, 1)
	go func() {
		snapshot, err := c.Activity("ssh-acceptance", "first", agent, boot, "list", "", "", "", 0)
		readDone <- readResult{snapshot: snapshot, err: err}
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("activity request did not reach the SSH command")
	}
	started := make(chan struct{}, 1)
	type runResult struct {
		result environment.Result
		err    error
	}
	runDone := make(chan runResult, 1)
	go func() {
		result, err := rt.Run(ctx, environment.Command{Program: "sh", Args: []string{"-c", "printf '%s\\n' 'NEXUM_DESKTOP_PROGRESS:install_service'; sleep 2"},
			Progress: func(string) {
				select {
				case started <- struct{}{}:
				default:
				}
			}})
		runDone <- runResult{result: result, err: err}
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("SSH command did not start before disconnect")
	}
	_ = rt.Close()
	close(gate.release)
	read := <-readDone
	if read.err == nil || read.snapshot.Activity.List != nil {
		t.Fatal("activity returned data after the SSH connection was severed")
	}
	interrupted := <-runDone
	if !errors.Is(interrupted.err, environment.ErrUnknownOutcome) || interrupted.result.OutcomeKnown {
		t.Fatal("in-flight SSH disconnect did not remain an unknown outcome")
	}
	if _, err := c.Activity("ssh-acceptance", "first", agent, boot, "list", "", "", "", 0); err == nil {
		t.Fatal("disconnected lifecycle session accepted a new read")
	}
	rt2 := dial(ctx)
	t.Cleanup(func() { _ = rt2.Close() })
	c2 := newController(rt2, "reconnected")
	if _, err := c2.Activity("ssh-acceptance", "first", agent, boot, "list", "", "", "", 0); err == nil {
		t.Fatal("old operation was accepted after reconnect")
	}
	if fresh, err := c2.Activity("ssh-acceptance", "reconnected", agent, boot, "list", "", "", "", 0); err != nil || fresh.Activity.List == nil {
		t.Fatal("activity did not recover on a newly verified SSH connection")
	}
}
