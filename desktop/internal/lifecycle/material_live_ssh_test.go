//go:build !windows

package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// This opt-in test operates only on a newly created, uniquely named script
// in the local development Profile, via Desktop's real SSH transport.
func TestMaterialsDevelopmentLoopbackSSH(t *testing.T) {
	if os.Getenv("NEXUM_TEST_MATERIALS_DEV_SSH") != "1" {
		t.Skip("requires explicit local development SSH acceptance")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, ".nexum-dev")
	scripts := filepath.Join(root, "scripts")
	if actual, err := filepath.EvalSymlinks(scripts); err != nil || actual != scripts {
		t.Fatal("development scripts directory is unavailable or redirected")
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	name := "materials-ssh-acceptance-" + hex.EncodeToString(nonce[:]) + ".js"
	filename := filepath.Join(scripts, name)
	header, _ := json.Marshal(map[string]any{"scriptName": name, "scriptDesc": "Desktop SSH acceptance fixture",
		"scriptWhenUse": "Only for development verification", "scriptInputSchema": map[string]string{"type": "object"}})
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	created, err := file.Stat()
	if err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if current, err := os.Lstat(filename); err == nil && os.SameFile(created, current) {
			_ = os.Remove(filename)
		}
	})
	if _, err := file.WriteString("/** " + string(header) + " */\nreturn 1;\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if closeErr := file.Close(); closeErr != nil {
		t.Fatal("could not finalize the development fixture")
	}
	const origin = "https://nexum-dev.y2l.top"
	command := exec.Command(filepath.Join(root, "bin", "nexum-agent"), "desktop", "observe", "--profile", "development", "--server", origin)
	data, err := command.Output()
	if err != nil {
		t.Fatal("development Agent observation failed")
	}
	var observed Facts
	if json.Unmarshal(data, &observed) != nil || observed.Profile != "development" || observed.Live == nil ||
		!observed.Live.CloudOnline || !observed.Live.OriginMatches || !observed.Live.ExecutionReady {
		t.Fatal("development Agent is not ready and connected")
	}
	config, err := exec.Command("ssh", "-G", "localhost").Output()
	if err != nil {
		t.Fatal("cannot inspect localhost SSH configuration")
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
		t.Fatal("incomplete localhost SSH configuration")
	}
	expand := func(value string) string {
		if strings.HasPrefix(value, "~/") {
			return filepath.Join(home, value[2:])
		}
		return value
	}
	var hosts []string
	for _, path := range strings.Fields(settings["userknownhostsfile"]) {
		path = expand(path)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			hosts = append(hosts, path)
		}
	}
	verify, err := knownhosts.New(hosts...)
	if err != nil || len(hosts) == 0 {
		t.Fatal("localhost host key is unavailable")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	remote, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	rt, err := environment.Dial(ctx, environment.SSHConfig{Host: host, Port: port, Username: settings["user"], AuthType: "key"},
		environment.Secret{KeyPath: expand(settings["identityfile"])}, func(key ssh.PublicKey) error { return verify(address, remote, key) })
	if err != nil {
		t.Fatalf("Desktop SSH connection failed: %s", environment.ErrorCode(err))
	}
	defer rt.Close()
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", origin)
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	c.current = &session{id: "ssh-fixture", operation: "operation", rt: rt, ctx: sessionCtx, cancel: sessionCancel,
		state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: observed.Live.AgentID, BootID: observed.Live.BootID, Cloud: "online"}}}
	defer c.Close()
	id, boot := observed.Live.AgentID, observed.Live.BootID
	read := func() (WorkspaceSnapshot, error) {
		return c.OnlineMaterialsContext(ctx, "ssh-fixture", "operation", id, boot, "", "", "")
	}
	view, err := read()
	if err != nil || view.Materials == nil || view.Materials.List == nil {
		t.Fatal("Desktop SSH materials inventory failed", err)
	}
	var resourceID string
	for _, item := range view.Materials.List.Items {
		if item.Name == name && item.Kind == "script" && item.CanRemove {
			resourceID = item.ID
		}
	}
	if resourceID == "" {
		t.Fatal("development fixture is absent or not removable")
	}
	prepared, err := c.RemoveMaterial("ssh-fixture", "operation", id, boot, "prepare", "script", resourceID, "")
	if err != nil || prepared.Location != filename || prepared.Token == "" {
		t.Fatalf("Desktop SSH removal preparation failed: %v", err)
	}
	if _, err := c.RemoveMaterial("ssh-fixture", "operation", id, boot, "commit", "script", resourceID, prepared.Token); err != nil {
		t.Fatalf("Desktop SSH removal or readback failed: %v", err)
	}
	if _, err := os.Lstat(filename); !os.IsNotExist(err) {
		t.Fatalf("development fixture still exists: %v", err)
	}
	view, err = read()
	if err != nil || view.Materials == nil || view.Materials.List == nil {
		t.Fatal("Desktop SSH inventory after deletion failed", err)
	}
	for _, item := range view.Materials.List.Items {
		if item.ID == resourceID {
			t.Fatal("deleted development fixture remained in the inventory")
		}
	}
}
