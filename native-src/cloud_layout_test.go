package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCloudManagedWorkLayoutUsesIsolatedCoreDirectory(t *testing.T) {
	home, err := os.MkdirTemp("", "nexum-native-work-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	cfg, err := parseConfig([]string{"--profile", "development", "--home", home, "--layout", "work"})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, ".nexum-dev")
	if cfg.program != root || cfg.node != nativeNode(root) ||
		cfg.runner != filepath.Join(root, "core", "node_modules", "@nexum-hub", "agent", "dist", "cli.js") {
		t.Fatalf("Cloud-managed native layout is inconsistent: %+v", cfg)
	}
	if _, err := parseConfig([]string{"--profile", "development", "--home", home, "--layout", "unknown"}); err == nil {
		t.Fatal("unknown installation layout was accepted")
	}
}
