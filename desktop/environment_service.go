package main

import (
	"context"
	"errors"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
	"time"
)

func (s *FoundationService) environmentManager() (*environment.Manager, error) {
	if e := s.requireReady(); e != nil {
		return nil, e
	}
	s.envMu.Lock()
	defer s.envMu.Unlock()
	if s.envClosed {
		return nil, environment.ErrDisconnected
	}
	if s.environments == nil {
		s.environments = environment.NewManager(s.store, environment.NewNativeVault(currentProfile.AppID()))
	}
	return s.environments, nil
}
func (s *FoundationService) closeEnvironments() {
	s.envMu.Lock()
	s.envClosed = true
	m := s.environments
	s.envMu.Unlock()
	if m != nil {
		m.Close()
	}
}
func (s *FoundationService) GetEnvironmentState() (environment.Snapshot, error) {
	m, e := s.environmentManager()
	if e != nil {
		return environment.Snapshot{}, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return m.Snapshot(ctx)
}
func (s *FoundationService) ChooseEnvironmentPrivateKey() (environment.KeySelection, error) {
	m, e := s.environmentManager()
	if e != nil {
		return environment.KeySelection{}, e
	}
	if s.chooseSSHKey == nil {
		return environment.KeySelection{}, errors.New("native file dialog unavailable")
	}
	generation, e := m.BeginKeySelection()
	if e != nil {
		return environment.KeySelection{}, e
	}
	path, e := s.chooseSSHKey()
	if e != nil {
		return environment.KeySelection{}, errors.New("key selection failed")
	}
	return m.FinishKeySelection(generation, path)
}
func (s *FoundationService) ClearEnvironmentPrivateKey() error {
	m, e := s.environmentManager()
	if e != nil {
		return e
	}
	m.ClearKey()
	return nil
}
func (s *FoundationService) StartEnvironmentConnection(req environment.Request) (environment.Attempt, error) {
	m, e := s.environmentManager()
	if e != nil {
		return environment.Attempt{}, e
	}
	return m.Start(req)
}
func (s *FoundationService) TrustEnvironmentHost(id, fingerprint string) error {
	m, e := s.environmentManager()
	if e != nil {
		return e
	}
	return m.Trust(id, fingerprint)
}
func (s *FoundationService) CancelEnvironmentConnection(id string) error {
	m, e := s.environmentManager()
	if e != nil {
		return e
	}
	return m.Cancel(id)
}
func (s *FoundationService) DisconnectEnvironment(id string) error {
	m, e := s.environmentManager()
	if e != nil {
		return e
	}
	c, e := s.lifecycleController()
	if e != nil {
		return e
	}
	return c.GuardEnvironmentChange(id, func() error { return m.Disconnect(id) })
}
func (s *FoundationService) RemoveEnvironment(id string) error {
	m, e := s.environmentManager()
	if e != nil {
		return e
	}
	c, e := s.lifecycleController()
	if e != nil {
		return e
	}
	return c.GuardEnvironmentChange(id, func() error { return m.Remove(id) })
}
