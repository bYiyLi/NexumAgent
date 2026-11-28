package main

import (
	"context"
	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
	"log/slog"
	"os"
	"runtime"
	"sync"
)

var version = "0.1.0"

type DesktopInfo struct {
	Profile   string `json:"profile"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	Theme     string `json:"theme"`
	Language  string `json:"language"`
	LocalHost string `json:"localHost"`
	Platform  string `json:"platform"`
}

type FoundationService struct {
	store                 *desktopstate.Store
	logger                *slog.Logger
	ready                 sync.Once
	system                *clientSystem
	bootstrap             *bootstrapController
	envMu                 sync.Mutex
	envClosed             bool
	environments          *environment.Manager
	chooseSSHKey          func() (string, error)
	nativeMenu            nativeMenuState
	lifecycleMu           sync.Mutex
	lifecycleClosed       bool
	lifecycle             *lifecycle.Controller
	materialsMu           sync.Mutex
	materialsWorker       sync.Mutex
	materials             *materialMonitor
	openAgentBrowser      func(string) error
	capabilityControlMu   sync.Mutex
	capabilityMu          sync.Mutex
	capabilityQueryMu     sync.Mutex
	capabilityQueryCtx    context.Context
	capabilityQueryStop   context.CancelFunc
	capabilityClosed      bool
	capabilityVisible     bool
	capabilityDetailOpen  bool
	capabilityScope       capabilitywatch.Scope
	capabilitySnapshot    capabilitywatch.Snapshot
	capabilityMonitor     *capabilitywatch.Scheduler
	capabilityEmit        func()
	capabilityActions     map[string]bool
	capabilityUnknown     map[string]bool
	capabilityMaintenance map[string]*capabilityMaintenanceEntry
}

func (s *FoundationService) Info() (DesktopInfo, error) {
	if e := s.requireReady(); e != nil {
		return DesktopInfo{}, e
	}
	theme, err := s.store.Theme()
	if err != nil {
		return DesktopInfo{}, err
	}
	language, err := s.store.Language()
	if err == nil {
		s.ready.Do(func() {
			if s.logger != nil {
				s.logger.Info("desktop frontend ready", "profile", currentProfile)
			}
		})
	}
	hostname, _ := os.Hostname()
	return DesktopInfo{Profile: string(currentProfile), Name: currentProfile.Name(), Version: version, Theme: theme, Language: language, LocalHost: hostname, Platform: runtime.GOOS}, err
}

func (s *FoundationService) SetTheme(theme string) error {
	if e := s.requireReady(); e != nil {
		return e
	}
	return s.store.SetTheme(theme)
}

func (s *FoundationService) SetLanguage(language string) error {
	if e := s.requireReady(); e != nil {
		return e
	}
	if err := s.store.SetLanguage(language); err != nil {
		return err
	}
	if s.bootstrap != nil {
		s.bootstrap.publish(func(snapshot *BootstrapSnapshot) { snapshot.Info.Language = language })
	}
	return nil
}
