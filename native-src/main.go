// nexum-agent is the native, windowless operating-system entrypoint.
// It owns neither Cloud credentials nor Agent business logic.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

type launchConfig struct {
	profile string
	home    string
	layout  string
	program string
	node    string
	runner  string
}

func parseConfig(args []string) (launchConfig, error) {
	var config launchConfig
	set := flag.NewFlagSet("nexum-agent", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	set.StringVar(&config.profile, "profile", "", "development or production")
	set.StringVar(&config.home, "home", "", "absolute user home")
	set.StringVar(&config.layout, "layout", "legacy", "legacy or work")
	if err := set.Parse(args); err != nil {
		return config, err
	}
	if set.NArg() != 0 || (config.profile != "development" && config.profile != "production") {
		return config, errors.New("a supported --profile is required")
	}
	if config.home == "" || !filepath.IsAbs(config.home) || filepath.Clean(config.home) != config.home {
		return config, errors.New("a canonical absolute --home is required")
	}
	if config.layout != "legacy" && config.layout != "work" {
		return config, errors.New("invalid Agent installation layout")
	}
	profileName := ".nexum"
	if config.profile == "development" {
		profileName = ".nexum-dev"
	}
	config.program = filepath.Join(config.home, profileName, "program")
	if config.layout == "work" {
		config.program = filepath.Join(config.home, profileName)
	}
	config.node = nativeNode(config.program)
	config.runner = filepath.Join(config.program, "service-runner.mjs")
	if config.layout == "work" {
		config.runner = filepath.Join(config.program, "core", "node_modules",
			"@nexum-hub", "agent", "dist", "cli.js")
	}
	return config, nil
}

func main() {
	config, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "nexum-agent: invalid start configuration")
		os.Exit(2)
	}
	if err := run(config); err != nil {
		fmt.Fprintln(os.Stderr, "nexum-agent: native start failed")
		os.Exit(1)
	}
}
