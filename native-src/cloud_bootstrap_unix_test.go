//go:build darwin || linux

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareCloudDownloadsBootstrapFromConfiguredServer(t *testing.T) {
	home := t.TempDir()
	cfg, err := parseConfig([]string{
		"--profile", "development",
		"--home", home,
		"--layout", "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cfg.program, 0o700); err != nil {
		t.Fatal(err)
	}

	marker := filepath.Join(cfg.program, "bootstrap-ran")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/install.sh" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/x-shellscript")
		_, _ = io.WriteString(w, "#!/bin/sh\nprintf '%s' ok > \"$NEXUM_TEST_MARKER\"\n")
	}))
	defer server.Close()

	configFile, err := json.Marshal(map[string]string{"server_url": server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.program, "config.json"),
		append(configFile, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEXUM_TEST_MARKER", marker)

	logFile, err := os.OpenFile(filepath.Join(cfg.program, "bootstrap.log"),
		os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	if err := prepareCloud(cfg, logFile); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "ok" {
		t.Fatalf("bootstrap marker = %q", data)
	}
}
