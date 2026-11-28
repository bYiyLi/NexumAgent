//go:build windows

package environment

import (
	"context"
	"github.com/Microsoft/go-winio"
	"net"
)

func openSSHAgent(ctx context.Context) (net.Conn, error) {
	return winio.DialPipeContext(ctx, `\\.\pipe\openssh-ssh-agent`)
}
