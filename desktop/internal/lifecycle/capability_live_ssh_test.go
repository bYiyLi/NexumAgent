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

// Override HOME for this fixture's commands only. SSH authentication and
// host-key validation remain the actual Desktop transport implementation.
type capabilityIsolatedSSH struct {
	environment.Runtime
	home string
}

func (r capabilityIsolatedSSH) Identity() environment.Identity {
	id := r.Runtime.Identity()
	id.Home = r.home
	return id
}

func (r capabilityIsolatedSSH) Run(ctx context.Context, command environment.Command) (environment.Result, error) {
	if command.Env == nil {
		command.Env = map[string]string{}
	}
	command.Env["HOME"] = r.home
	return r.Runtime.Run(ctx, command)
}

// The parent real-Node test supplies a private temporary development Agent.
// Never use the user's installed profile for this acceptance test.
func TestCapabilityLiveLoopbackSSH(t *testing.T) {
	if os.Getenv("NEXUM_TEST_CAPABILITY_LOOPBACK_SSH") != "1" {
		t.Skip("requires the isolated real-Node capability fixture")
	}
	home := os.Getenv("NEXUM_TEST_CAPABILITY_HOME")
	origin := os.Getenv("NEXUM_TEST_CAPABILITY_ORIGIN")
	agent, boot := os.Getenv("NEXUM_TEST_CAPABILITY_AGENT"), os.Getenv("NEXUM_TEST_CAPABILITY_BOOT")
	api, mcp := os.Getenv("NEXUM_TEST_CAPABILITY_API"), os.Getenv("NEXUM_TEST_CAPABILITY_MCP")
	u, err := url.Parse(origin)
	if !filepath.IsAbs(home) || !strings.HasPrefix(home, "/private/tmp/nx-caps-ipc-") || filepath.Clean(home) != home ||
		err != nil || u.Scheme != "http" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() ||
		agent != "agent_a" || boot != "boot_0123456789abcdef0123456789abcdef" || !validCapabilityResourceID(api) || !validCapabilityResourceID(mcp) {
		t.Fatal("the required isolated capability fixture was not supplied")
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal("cannot determine the local account home")
	}
	config, err := exec.Command("ssh", "-G", "localhost").Output()
	if err != nil {
		t.Fatal("cannot read the loopback SSH configuration")
	}
	settings := map[string]string{}
	for _, line := range strings.Split(string(config), "\n") {
		key, value, ok := strings.Cut(line, " ")
		if ok && settings[key] == "" {
			settings[key] = strings.TrimSpace(value)
		}
	}
	host := settings["hostname"]
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		t.Fatal("SSH target must be loopback")
	}
	port, err := strconv.Atoi(settings["port"])
	if err != nil || settings["user"] == "" || settings["identityfile"] == "" {
		t.Fatal("incomplete loopback SSH configuration")
	}
	expand := func(value string) string {
		if value == "~" {
			return userHome
		}
		if strings.HasPrefix(value, "~/") {
			return filepath.Join(userHome, value[2:])
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
		t.Fatal("no existing known-hosts file is available")
	}
	verifyHost, err := knownhosts.New(hosts...)
	if err != nil {
		t.Fatal("cannot load the existing SSH host keys")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	remote, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatal("cannot resolve loopback SSH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	rt, err := environment.Dial(ctx, environment.SSHConfig{Host: host, Port: port, Username: settings["user"], AuthType: "key"},
		environment.Secret{KeyPath: expand(settings["identityfile"])}, func(key ssh.PublicKey) error { return verifyHost(address, remote, key) })
	if err != nil {
		t.Fatalf("verified SSH connection failed: %s", environment.ErrorCode(err))
	}
	defer rt.Close()
	isolated := capabilityIsolatedSSH{Runtime: rt, home: home}
	c := New(func(string) (environment.Runtime, error) { return isolated, nil }, "development", origin)
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	c.current = &session{id: "ssh-fixture", operation: "operation", rt: isolated, ctx: sessionCtx, cancel: sessionCancel,
		state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: agent, BootID: boot}}}
	defer c.Close()
	scope := capabilitywatch.Scope{TargetID: "ssh-fixture", OperationID: "operation", AgentID: agent, BootID: boot}
	state, err := c.CapabilityState(ctx, scope)
	if err != nil {
		t.Fatal("real SSH capability-state failed", err)
	}
	facts := map[string]capabilitywatch.Fact{}
	for _, fact := range state.Facts {
		facts[fact.ID] = fact
	}
	if facts[api].State != "active" || facts[mcp].State != "active" || facts[mcp].Revision == "" {
		t.Fatal("SSH capability facts did not match the isolated Agent")
	}
	if _, _, err := c.CapabilityPackages(ctx, scope, state.PackageRevision); err != nil {
		t.Fatal("real SSH package-facts read failed", err)
	}
	for _, id := range []string{api, mcp} {
		detail, err := c.CapabilityDetailContext(ctx, scope.TargetID, scope.OperationID, agent, boot, id)
		if err != nil || detail.Detail.ID != id || !detail.Detail.MethodsComplete {
			t.Fatal("real SSH capability detail failed", err)
		}
	}
	if status, err := c.ReconnectCapability(scope, mcp, facts[mcp].Revision); err != nil || status != "succeeded" {
		t.Fatalf("real SSH single-connection reconnect failed: %s %v", status, err)
	}
}

// The parent Cloud fixture starts a real Agent and Node Host in a temporary
// development profile. The Desktop controller uses its ordinary Local path.
func TestCapabilityLiveLocalCloud(t *testing.T) {
	if os.Getenv("NEXUM_TEST_CAPABILITY_LOCAL_CLOUD") != "1" {
		t.Skip("requires the isolated real-Cloud capability fixture")
	}
	home, origin := os.Getenv("NEXUM_TEST_CAPABILITY_HOME"), os.Getenv("NEXUM_TEST_CAPABILITY_ORIGIN")
	agent, boot, mcp := os.Getenv("NEXUM_TEST_CAPABILITY_AGENT"), os.Getenv("NEXUM_TEST_CAPABILITY_BOOT"), os.Getenv("NEXUM_TEST_CAPABILITY_MCP")
	u, err := url.Parse(origin)
	if !filepath.IsAbs(home) || !strings.HasPrefix(home, "/private/tmp/nx-caps-cloud-") || filepath.Clean(home) != home ||
		err != nil || u.Scheme != "http" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() ||
		agent == "" || !strings.HasPrefix(boot, "boot_") || !validCapabilityResourceID(mcp) {
		t.Fatal("the required isolated Cloud fixture was not supplied")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	rt := capabilityIsolatedSSH{Runtime: environment.NewLocal(), home: home}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", origin)
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	c.current = &session{id: "local-fixture", operation: "operation", rt: rt, ctx: sessionCtx, cancel: sessionCancel,
		state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: agent, BootID: boot}}}
	defer c.Close()
	scope := capabilitywatch.Scope{TargetID: "local-fixture", OperationID: "operation", AgentID: agent, BootID: boot}
	state, err := c.CapabilityState(ctx, scope)
	if err != nil {
		t.Fatal("real Cloud Agent capability state failed", err)
	}
	var selected capabilitywatch.Fact
	for _, fact := range state.Facts {
		if fact.ID == mcp {
			selected = fact
		}
	}
	if selected.State != "active" || selected.Revision == "" {
		t.Fatal("approved MCP state did not match the real Cloud Agent")
	}
	detail, err := c.CapabilityDetailContext(ctx, scope.TargetID, scope.OperationID, agent, boot, mcp)
	if err != nil || detail.Detail.ID != mcp || !detail.Detail.MethodsComplete {
		t.Fatal("real Cloud Agent capability detail failed", err)
	}
	if status, err := c.ReconnectCapability(scope, mcp, selected.Revision); err != nil || status != "succeeded" {
		t.Fatalf("real Cloud Agent reconnect failed: %s %v", status, err)
	}
}
