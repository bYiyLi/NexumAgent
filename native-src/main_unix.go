//go:build darwin || linux

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func nativeNode(program string) string {
	return filepath.Join(program, "runtime", "bin", "node")
}

func prepareCloud(config launchConfig, output *os.File) error {
	contents, err := os.ReadFile(filepath.Join(config.program, "config.json"))
	if err != nil {
		return err
	}
	var configFile struct {
		ServerURL string `json:"server_url"`
	}
	if err := json.Unmarshal(contents, &configFile); err != nil {
		return err
	}
	base, err := url.Parse(configFile.ServerURL)
	if err != nil || base.Host == "" ||
		(base.Scheme != "https" && !(config.profile == "development" && base.Scheme == "http")) ||
		base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return fmt.Errorf("invalid Cloud bootstrap URL")
	}
	bootstrapURL, err := url.JoinPath(base.String(), "agent/install.sh")
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodGet, bootstrapURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			if req.URL.Scheme != base.Scheme || req.URL.Host != base.Host {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("Cloud bootstrap download failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Cloud bootstrap HTTP status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) == 0 || len(data) > 1024*1024 {
		return fmt.Errorf("Cloud bootstrap size or read failure")
	}
	file, err := os.CreateTemp(config.program, ".bootstrap-*.sh")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	command := exec.Command("/bin/sh", name,
		"--server", strings.TrimRight(base.String(), "/"),
		"--profile", config.profile)
	command.Dir = config.program
	command.Env = append(os.Environ(), "NEXUM_BOOTSTRAP_SERVICE=1")
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("Cloud bootstrap execution failed")
	}
	return nil
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
	if config.layout == "work" {
		if err := prepareCloud(config, os.Stderr); err != nil {
			return err
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
		// Keep nexum-agent visible as the stable OS process identity. No
		// JavaScript launcher or second permanent supervisor is required.
		environment = append(environment, "NEXUM_CLOUD_BOOTSTRAP=1")
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
