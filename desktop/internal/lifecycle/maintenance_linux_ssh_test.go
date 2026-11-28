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

// This opt-in test runs only the specified Native tests in a dedicated
// temporary directory, as an unprivileged user on an authorized Linux host.
func TestMaintenanceLinuxNativeOverSSH(t *testing.T) {
	raw := os.Getenv("NEXUM_TEST_MAINTENANCE_LINUX_SSH")
	if raw == "" {
		t.Skip("requires an explicitly configured disposable Linux SSH fixture")
	}
	var cfg struct {
		Host, Username, KeyPath, TestBinary string
		VerifiedFingerprint                 string
		Port                                int
		KnownHosts                          []string
	}
	if json.Unmarshal([]byte(raw), &cfg) != nil || cfg.Host == "" || cfg.Port == 0 || cfg.Username == "" || cfg.KeyPath == "" || len(cfg.KnownHosts) == 0 {
		t.Fatal("incomplete Linux SSH fixture")
	}
	base := path.Dir(cfg.TestBinary)
	if !strings.HasPrefix(base, "/tmp/nexum-maintenance-ssh.") || path.Clean(base) != base || cfg.TestBinary != path.Join(base, "nativeagent.test") {
		t.Fatal("native tests must be in the dedicated temporary directory")
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
	var offeredFingerprint string
	rt, err := environment.Dial(ctx, environment.SSHConfig{Host: cfg.Host, Port: cfg.Port, Username: cfg.Username, AuthType: "key"},
		environment.Secret{KeyPath: cfg.KeyPath}, func(key ssh.PublicKey) error {
			offeredFingerprint = ssh.FingerprintSHA256(key)
			err := hostCheck(address, remote, key)
			if err != nil && strings.HasPrefix(cfg.VerifiedFingerprint, "SHA256:") && cfg.VerifiedFingerprint == offeredFingerprint {
				return nil
			}
			return err
		})
	if err != nil {
		t.Fatalf("verified Linux SSH failed: %s; offered host key %s", environment.ErrorCode(err), offeredFingerprint)
	}
	defer rt.Close()
	if id := rt.Identity(); id.Platform != "linux" || id.Arch != "amd64" {
		t.Fatal("unexpected Linux test platform")
	}
	pattern := "^Test(DesktopSystemEventsAreBoundedAndDoNotExposeRawFields|DesktopSystemEventsHandleEmptyAndRedirectedLog|DesktopStopAdmissionChecksBootAndOnlySignalsAfterAcceptance|DesktopUninstallRecordBindsProfileOriginAndAgent|DesktopUninstallRejectsRedirectedRecord|DesktopUninstallRemovesOnlyMatchingServiceDefinition|LinuxDesktopServiceStateRequiresExactProfileUnit|DesktopServiceDefinitionsScoped)$"
	result, err := rt.Run(ctx, environment.Command{Program: "/usr/sbin/runuser", Args: []string{"-u", "nobody", "--", cfg.TestBinary, "-test.run", pattern, "-test.v", "-test.timeout", "90s"}})
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated {
		t.Fatalf("remote Linux native suite failed: outcomeKnown=%t exit=%d truncated=%t", result.OutcomeKnown, result.ExitCode, result.Truncated)
	}
	for _, name := range []string{"TestDesktopSystemEventsAreBoundedAndDoNotExposeRawFields", "TestDesktopSystemEventsHandleEmptyAndRedirectedLog",
		"TestDesktopStopAdmissionChecksBootAndOnlySignalsAfterAcceptance", "TestDesktopUninstallRecordBindsProfileOriginAndAgent", "TestDesktopUninstallRejectsRedirectedRecord",
		"TestDesktopUninstallRemovesOnlyMatchingServiceDefinition", "TestLinuxDesktopServiceStateRequiresExactProfileUnit", "TestDesktopServiceDefinitionsScoped"} {
		if !strings.Contains(result.Stdout, "--- PASS: "+name+" ") {
			t.Fatalf("Linux native suite did not pass %s", name)
		}
	}
	if strings.Contains(result.Stdout, "--- SKIP:") {
		t.Fatal("Linux native suite skipped an acceptance case")
	}
}
