package main

import (
	"slices"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
)

// Preview launch is never enabled in a production profile.
func desktopStartURL(profile desktopstate.Profile, args []string) string {
	if profile == desktopstate.Development {
		if slices.Contains(args, "--preview-startup") {
			return "/?preview=startup"
		}
		if slices.Contains(args, "--preview-agent-lifecycle") {
			return "/?preview=agent-lifecycle"
		}
		if slices.Contains(args, "--preview-environment-check") {
			return "/?preview=environment-check"
		}
		if slices.Contains(args, "--preview-agent-upgrade") {
			return "/?preview=agent-upgrade"
		}
		if slices.Contains(args, "--preview-agent-repair") {
			return "/?preview=agent-repair"
		}
		if slices.Contains(args, "--preview-agent-start") {
			return "/?preview=agent-start"
		}
		if slices.Contains(args, "--preview-agent-workspace") {
			return "/?preview=agent-workspace"
		}
		if slices.Contains(args, "--preview-environment") {
			return "/?preview=environment"
		}
	}
	return "/"
}
