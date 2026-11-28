package lifecycle

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// The optional fixture paths must refer to one dedicated temporary directory
// on a Linux SSH target. The remote test runs as an unprivileged account.
func TestActivityLinuxNativeOverSSH(t *testing.T) {
	raw := os.Getenv("NEXUM_TEST_ACTIVITY_LINUX_SSH")
	if raw == "" {
		t.Skip("requires an explicitly configured disposable Linux SSH fixture")
	}
	var cfg struct {
		Host                string   `json:"host"`
		Port                int      `json:"port"`
		Username            string   `json:"username"`
		KeyPath             string   `json:"keyPath"`
		KnownHosts          []string `json:"knownHosts"`
		VerifiedFingerprint string   `json:"verifiedFingerprint"`
		TestBinary          string   `json:"testBinary"`
		Agent               string   `json:"agentBinary"`
	}
	if json.Unmarshal([]byte(raw), &cfg) != nil || cfg.Host == "" || cfg.Port == 0 || cfg.Username == "" || cfg.KeyPath == "" || len(cfg.KnownHosts) == 0 {
		t.Fatal("incomplete Linux SSH acceptance configuration")
	}
	base := path.Dir(cfg.TestBinary)
	if !strings.HasPrefix(base, "/tmp/nexum-activity-ssh.") || path.Clean(base) != base ||
		cfg.TestBinary != path.Join(base, "agentapp.test") || cfg.Agent != path.Join(base, "nexum-agent") {
		t.Fatal("remote acceptance files must be in the dedicated temporary directory")
	}
	hostCheck, err := knownhosts.New(cfg.KnownHosts...)
	if err != nil {
		t.Fatal("cannot load existing SSH host keys")
	}
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	remote, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatal("cannot resolve the configured SSH host")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	var verifyFailure string
	rt, err := environment.Dial(ctx, environment.SSHConfig{Host: cfg.Host, Port: cfg.Port, Username: cfg.Username, AuthType: "key"},
		environment.Secret{KeyPath: cfg.KeyPath}, func(key ssh.PublicKey) error {
			err := hostCheck(address, remote, key)
			// An operator may also supply the exact key fingerprint verified over
			// an independently authenticated connection to the same host.
			if err != nil && strings.HasPrefix(cfg.VerifiedFingerprint, "SHA256:") && ssh.FingerprintSHA256(key) == cfg.VerifiedFingerprint {
				return nil
			}
			if err != nil {
				verifyFailure = key.Type()
			}
			return err
		})
	if err != nil {
		t.Fatalf("verified Linux SSH failed: %s host-key-check=%s", environment.ErrorCode(err), verifyFailure)
	}
	defer rt.Close()
	identity := rt.Identity()
	if identity.Platform != "linux" || identity.Arch != "amd64" {
		t.Fatal("unexpected Linux test platform")
	}
	pattern := "^Test(ActivityCLI|DeskIPC|DesktopActivity(UsesRetainedRunSnapshots|RejectsUnsafeWorkAndRequests|PaginatesRetainedRuns|ProjectsRetainedArtifacts|RuntimeReadsArtifactsAndCloses|WorkDirectoryPermission|MissingSnapshot))$"
	result, err := rt.Run(ctx, environment.Command{Program: "/usr/sbin/runuser", Args: []string{"-u", "nobody", "--", "/usr/bin/env",
		"NEXUM_TEST_DESKTOP_ACTIVITY_BINARY=" + cfg.Agent, cfg.TestBinary, "-test.run", pattern, "-test.v", "-test.timeout", "90s"}})
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated {
		t.Fatalf("remote Linux native suite failed: outcomeKnown=%t exit=%d truncated=%t", result.OutcomeKnown, result.ExitCode, result.Truncated)
	}
	for _, name := range []string{"TestActivityCLI", "TestDeskIPC", "TestDesktopActivityUsesRetainedRunSnapshots", "TestDesktopActivityRejectsUnsafeWorkAndRequests",
		"TestDesktopActivityPaginatesRetainedRuns", "TestDesktopActivityProjectsRetainedArtifacts", "TestDesktopActivityRuntimeReadsArtifactsAndCloses",
		"TestDesktopActivityWorkDirectoryPermission", "TestDesktopActivityMissingSnapshot"} {
		if !strings.Contains(result.Stdout, "--- PASS: "+name+" ") {
			t.Fatalf("Linux native suite did not pass %s", name)
		}
	}
	if strings.Contains(result.Stdout, "--- SKIP:") {
		t.Fatal("Linux native suite skipped an acceptance case")
	}
	t.Log("nine unprivileged Linux native activity cases passed through the Desktop SSH runtime")
}
