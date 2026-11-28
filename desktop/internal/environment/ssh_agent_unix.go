//go:build !windows

package environment

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func openSSHAgent(ctx context.Context) (net.Conn, error) {
	socket := os.Getenv("SSH_AUTH_SOCK")
	if socket == "" && runtime.GOOS == "darwin" {
		out, e := exec.CommandContext(ctx, "/bin/launchctl", "getenv", "SSH_AUTH_SOCK").Output()
		if e == nil {
			socket = strings.TrimSpace(string(out))
		}
	}
	if socket == "" {
		return nil, errors.New("system SSH agent unavailable")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", socket)
}
