//go:build darwin || linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

func nativeNode(program string) string {
	return filepath.Join(program, "runtime", "bin", "node")
}

func run(config launchConfig) error {
	for _, file := range []string{config.node, config.runner} {
		info, err := os.Lstat(file)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("an Agent runtime entry is not a regular file")
		}
	}
	// This process is replaced by Node. launchd/systemd remain the sole
	// lifecycle owners; there is no second resident supervisor.
	environment := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		key := entry
		if at := len(entry); at > 0 {
			for i := 0; i < at; i++ {
				if entry[i] == '=' {
					key = entry[:i]
					break
				}
			}
		}
		switch key {
		case "HOME", "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE":
			continue
		}
		environment = append(environment, entry)
	}
	environment = append(environment, "HOME="+config.home)
	if config.layout == "work" {
		// Cloud initialization has already finished in the OS service pre-start.
		cmd := exec.Command(config.node, "--experimental-vm-modules", config.runner,
			"run", "--profile", config.profile)
		cmd.Env = environment
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		stopping := make(chan os.Signal, 1)
		signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT)
		defer signal.Stop(stopping)
		ended := make(chan error, 1)
		go func() { ended <- cmd.Wait() }()
		select {
		case err := <-ended:
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 78 {
				return nil // Permanently rejected Cloud credentials, no restart.
			}
			return err
		case sig := <-stopping:
			_ = cmd.Process.Signal(sig)
			return <-ended
		}
	}
	argv := []string{config.node, "--experimental-vm-modules", config.runner, "--profile", config.profile}
	return syscall.Exec(config.node, argv, environment)
}
