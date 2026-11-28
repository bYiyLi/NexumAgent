//go:build darwin

package main

import (
	"context"
	"os/exec"
	"time"
)

func showStartupError() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	_ = exec.CommandContext(ctx, "/usr/bin/osascript", "-e", "display alert \"Nexum Desktop\" message \"The client could not prepare its local environment. Check its installation and data directory.\" as critical").Run()
}
