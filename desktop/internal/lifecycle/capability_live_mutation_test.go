//go:build !windows

package lifecycle

import (
	"context"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// The parent starts a disposable actual Cloud, Agent and Node Host.
// This exercises the real local/SSH controller without a browser or an OS
// service restart (the isolated Agent is owned by the parent test process).
func TestCapabilityLiveLocalMutation(t *testing.T) {
	if os.Getenv("NEXUM_TEST_CAPABILITY_MUTATION_FIXTURE") != "1" {
		t.Skip("requires the isolated Cloud/Agent fixture")
	}
	home, origin := os.Getenv("NEXUM_TEST_CAPABILITY_HOME"), os.Getenv("NEXUM_TEST_CAPABILITY_ORIGIN")
	agent, boot := os.Getenv("NEXUM_TEST_CAPABILITY_AGENT"), os.Getenv("NEXUM_TEST_CAPABILITY_BOOT")
	id, revision, kind := os.Getenv("NEXUM_TEST_CAPABILITY_MCP"), os.Getenv("NEXUM_TEST_CAPABILITY_REVISION"), os.Getenv("NEXUM_TEST_CAPABILITY_KIND")
	u, err := url.Parse(origin)
	if !filepath.IsAbs(home) || !strings.HasPrefix(home, "/private/tmp/nx-caps-cloud-") || filepath.Clean(home) != home || err != nil || u.Scheme != "http" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() || agent == "" || !strings.HasPrefix(boot, "boot_") || !validCapabilityResourceID(id) || !validCapabilityResourceID("res_"+revision) || !oneOf(kind, "mcp", "openapi") {
		t.Fatal("invalid isolated fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var rt environment.Runtime = capabilityIsolatedSSH{Runtime: environment.NewLocal(), home: home}
	target := "local-fixture"
	if os.Getenv("NEXUM_TEST_CAPABILITY_SSH") == "1" {
		rt = capabilityMutationLoopbackSSH(t, ctx, home)
		target = "ssh-fixture"
	}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", origin)
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	c.current = &session{id: target, operation: "operation", rt: rt, ctx: sessionCtx, cancel: sessionCancel, state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: agent, BootID: boot, Cloud: "online"}}}
	defer c.Close()
	scope := capabilitywatch.Scope{TargetID: target, OperationID: "operation", AgentID: agent, BootID: boot}
	state, err := c.CapabilityState(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	var selected capabilitywatch.Fact
	for _, fact := range state.Facts {
		if fact.ID == id && fact.Revision == revision && fact.Type == kind {
			selected = fact
		}
	}
	if selected.ID == "" {
		t.Fatal("selected resource changed")
	}
	if !c.LocalCapabilityMaintenanceAvailable(scope) {
		t.Fatal("local maintenance unavailable")
	}
	done := make(chan [3]string, 1)
	if err := c.StartLocalCapabilityMaintenance(scope, selected, "remove", "", func(status, boot, code string) { done <- [3]string{status, boot, code} }); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result[0] != "succeeded" || result[1] != boot {
			t.Fatalf("local removal not verified: %v", result)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func capabilityMutationLoopbackSSH(t *testing.T, ctx context.Context, home string) environment.Runtime {
	t.Helper()
	currentHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	data, err := exec.Command("ssh", "-G", "localhost").Output()
	if err != nil {
		t.Fatal("loopback SSH configuration unavailable")
	}
	settings := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, " ")
		if ok && settings[key] == "" {
			settings[key] = strings.TrimSpace(value)
		}
	}
	host := settings["hostname"]
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		t.Fatal("SSH target is not loopback")
	}
	port, err := strconv.Atoi(settings["port"])
	if err != nil || settings["user"] == "" || settings["identityfile"] == "" {
		t.Fatal("loopback SSH configuration incomplete")
	}
	expand := func(value string) string {
		if value == "~" {
			return currentHome
		}
		if strings.HasPrefix(value, "~/") {
			return filepath.Join(currentHome, value[2:])
		}
		return value
	}
	var hosts []string
	for _, file := range strings.Fields(settings["userknownhostsfile"]) {
		file = expand(file)
		if info, err := os.Stat(file); err == nil && info.Mode().IsRegular() {
			hosts = append(hosts, file)
		}
	}
	if len(hosts) == 0 {
		t.Fatal("no existing verified SSH host keys")
	}
	verify, err := knownhosts.New(hosts...)
	if err != nil {
		t.Fatal("cannot read SSH host keys")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	remote, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatal("cannot resolve loopback SSH")
	}
	runtime, err := environment.Dial(ctx, environment.SSHConfig{Host: host, Port: port, Username: settings["user"], AuthType: "key"},
		environment.Secret{KeyPath: expand(settings["identityfile"])}, func(key ssh.PublicKey) error { return verify(address, remote, key) })
	if err != nil {
		t.Fatal("verified loopback SSH unavailable")
	}
	t.Cleanup(func() { _ = runtime.Close() })
	return capabilityIsolatedSSH{Runtime: runtime, home: home}
}
