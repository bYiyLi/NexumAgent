package main

import (
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestDesktopPreviewIsDevelopmentOnly(t *testing.T) {
	for _, profile := range []desktopstate.Profile{desktopstate.Development, desktopstate.Production} {
		if got := desktopStartURL(profile, []string{"--preview-client-update"}); got != "/" {
			t.Fatalf("retired update preview flag must not open a separate route: %s", got)
		}
	}
	startupArgs := []string{"--preview-startup"}
	if got := desktopStartURL(desktopstate.Development, startupArgs); got != "/?preview=startup" {
		t.Fatalf("development startup preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, startupArgs); got != "/" {
		t.Fatalf("production startup preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-environment"}); got != "/?preview=environment" {
		t.Fatalf("development environment preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-environment"}); got != "/" {
		t.Fatalf("production environment preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-environment-check"}); got != "/?preview=environment-check" {
		t.Fatalf("development environment check preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-environment-check"}); got != "/" {
		t.Fatalf("production environment check preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-agent-upgrade"}); got != "/?preview=agent-upgrade" {
		t.Fatalf("development Agent upgrade preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-agent-upgrade"}); got != "/" {
		t.Fatalf("production Agent upgrade preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-agent-repair"}); got != "/?preview=agent-repair" {
		t.Fatalf("development Agent repair preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-agent-repair"}); got != "/" {
		t.Fatalf("production Agent repair preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-agent-workspace"}); got != "/?preview=agent-workspace" {
		t.Fatalf("development Agent workspace preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-agent-workspace"}); got != "/" {
		t.Fatalf("production Agent workspace preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, []string{"--preview-agent-start"}); got != "/?preview=agent-start" {
		t.Fatalf("development Agent start preview: %s", got)
	}
	if got := desktopStartURL(desktopstate.Production, []string{"--preview-agent-start"}); got != "/" {
		t.Fatalf("production Agent start preview must stay disabled: %s", got)
	}
	if got := desktopStartURL(desktopstate.Development, nil); got != "/" {
		t.Fatalf("normal development startup changed: %s", got)
	}
}

func TestSharedCanvasPalette(t *testing.T) {
	for _, tc := range []struct {
		theme      string
		systemDark bool
		want       application.RGBA
	}{
		{"light", true, application.NewRGB(248, 250, 252)},
		{"dark", false, application.NewRGB(20, 27, 45)},
		{"system", false, application.NewRGB(248, 250, 252)},
		{"system", true, application.NewRGB(20, 27, 45)},
	} {
		got, err := initialWindowBackground(tc.theme, tc.systemDark)
		if err != nil || got != tc.want {
			t.Fatalf("theme %s, system dark %t: got %+v, err %v, want %+v", tc.theme, tc.systemDark, got, err, tc.want)
		}
	}
}
