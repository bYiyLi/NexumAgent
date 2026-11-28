package main

import (
	"errors"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

// Origins are public product origins, selected with the build Profile.
// The WebView and SSH endpoint cannot supply an arbitrary Cloud URL.
func desktopCloudOrigin() string {
	if string(currentProfile) == "development" {
		return "https://nexum-dev.y2l.top"
	}
	return "https://nexum.y2l.top"
}
func (s *FoundationService) lifecycleController() (*lifecycle.Controller, error) {
	m, err := s.environmentManager()
	if err != nil {
		return nil, err
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.lifecycleClosed {
		return nil, errors.New("lifecycle_closed")
	}
	if s.lifecycle == nil {
		s.lifecycle = lifecycle.New(m.Runtime, string(currentProfile), desktopCloudOrigin())
	}
	return s.lifecycle, nil
}
func (s *FoundationService) CheckAgentEnvironment(targetID string) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	return c.Check(targetID)
}
func (s *FoundationService) GetAgentLifecycleState(targetID string) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	snapshot, e := c.Get(targetID)
	if e != nil {
		return snapshot, e
	}
	// Lifecycle observation stays active while the user opens settings or hides
	// the window. Material scheduling itself belongs to the Go monitor.
	if snapshot.Stage == "ready" && snapshot.Summary != nil {
		_, _ = s.GetAgentMaterialsOverview(snapshot.TargetID, snapshot.OperationID, snapshot.Summary.AgentID, snapshot.Summary.BootID)
	} else {
		s.stopMaterialsTarget(snapshot.TargetID, snapshot.OperationID)
	}
	return snapshot, nil
}
func (s *FoundationService) StartAgent(targetID, operationID string, revision uint64) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	return c.Start(targetID, operationID, revision)
}

func (s *FoundationService) BeginAgentMaintenance(targetID, operationID string, revision uint64, agentID, bootID, action string) (lifecycle.Snapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.Snapshot{}, err
	}
	language, _ := s.store.Language()
	return c.BeginAgentMaintenance(targetID, operationID, revision, agentID, bootID, action, s.nativeMenu.locale(language), s.openAgentBrowser)
}

func (s *FoundationService) GetAgentMaintenanceAvailability(targetID, operationID, agentID, bootID string) (bool, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return false, err
	}
	return c.MaintenanceAvailable(targetID, operationID, agentID, bootID)
}
func (s *FoundationService) AuthorizeAgent(targetID, operationID string, revision uint64) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	language, _ := s.store.Language()
	return c.Authorize(targetID, operationID, revision, s.nativeMenu.locale(language), s.openAgentBrowser)
}
func (s *FoundationService) CancelAgentAuthorization(targetID, operationID string) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	return c.CancelAuthorization(targetID, operationID)
}
func (s *FoundationService) ReopenAgentAuthorization(targetID, operationID string) error {
	c, e := s.lifecycleController()
	if e != nil {
		return e
	}
	return c.ReopenAuthorization(targetID, operationID, s.openAgentBrowser)
}
func (s *FoundationService) RepairAgent(targetID, operationID string, revision uint64) (lifecycle.Snapshot, error) {
	c, e := s.lifecycleController()
	if e != nil {
		return lifecycle.Snapshot{}, e
	}
	return c.Repair(targetID, operationID, revision)
}
func (s *FoundationService) LeaveAgentTarget(targetID, operationID string) {
	s.stopMaterialsTarget(targetID, operationID)
	c, e := s.lifecycleController()
	if e == nil {
		c.Leave(targetID, operationID)
	}
}
func (s *FoundationService) stopMaterialsTarget(targetID, operationID string) {
	s.materialsMu.Lock()
	if s.materials != nil && s.materials.key.TargetID == targetID && s.materials.key.OperationID == operationID {
		s.materials.cancel()
		s.materials = nil
	}
	s.materialsMu.Unlock()
}
func (s *FoundationService) closeLifecycle() {
	s.stopMaterialsMonitor()
	s.lifecycleMu.Lock()
	s.lifecycleClosed = true
	c := s.lifecycle
	s.lifecycleMu.Unlock()
	if c != nil {
		c.Close()
	}
}
