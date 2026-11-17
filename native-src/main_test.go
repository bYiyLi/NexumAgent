package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseConfigRejectsImplicitOrUnsafeProfiles(t *testing.T) {
	home, err := os.MkdirTemp("", "nexum-native-profile-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	for _, args := range [][]string{
		nil, {"--profile", "production"}, {"--home", home},
		{"--profile", "unknown", "--home", home},
		{"--profile", "development", "--home", "."},
		{"--profile", "development", "--home", home, "extra"},
		{"--profile", "development", "--home", home + string(filepath.Separator) + ".."},
	} {
		if _, err := parseConfig(args); err == nil {
			t.Fatalf("invalid native invocation accepted: %q", args)
		}
	}
}

func TestParseConfigPinsItsOwnProfileWithoutSecrets(t *testing.T) {
	home, err := os.MkdirTemp("", "nexum native 用户-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	for _, profile := range []string{"development", "production"} {
		config, err := parseConfig([]string{"--profile", profile, "--home", home})
		if err != nil {
			t.Fatal(err)
		}
		want := ".nexum"
		if profile == "development" {
			want = ".nexum-dev"
		}
		if config.program != filepath.Join(home, want, "program") {
			t.Errorf("incorrect profile directory: %s", config.program)
		}
		if !strings.HasPrefix(config.node, config.program) ||
			!strings.HasPrefix(config.runner, config.program) {
			t.Fatal("native execution escaped the managed program root")
		}
	}
}
