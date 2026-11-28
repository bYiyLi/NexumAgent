package main

import (
	"errors"
	"sort"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
)

type capabilityMaintenanceEntry struct {
	scope    capabilitywatch.Scope
	progress capabilitywatch.MaintenanceProgress
	revision string
}

func capabilityMaintenanceKey(scope capabilitywatch.Scope, id string) string {
	return scope.TargetID + "\x00" + scope.AgentID + "\x00" + scope.BootID + "\x00" + id
}
func sameCapabilityTarget(a, b capabilitywatch.Scope) bool {
	return a.TargetID == b.TargetID && a.AgentID == b.AgentID && a.BootID == b.BootID
}
func maintenanceTerminal(status string) bool {
	return status == "succeeded" || status == "failed" || status == "busy" || status == "changed" || status == "unavailable"
}

func (s *FoundationService) capabilityMaintenanceProgressLocked(scope capabilitywatch.Scope) []capabilitywatch.MaintenanceProgress {
	values := []capabilitywatch.MaintenanceProgress{}
	for _, entry := range s.capabilityMaintenance {
		if sameCapabilityTarget(entry.scope, scope) {
			progress := entry.progress
			progress.Restarted = progress.Restarted && entry.scope.OperationID == scope.OperationID
			values = append(values, progress)
		}
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	return values
}

// StartCapabilityMaintenance accepts only the exact currently observed
// capability and, for npm, an update version already confirmed by Desktop.
func (s *FoundationService) StartCapabilityMaintenance(targetID, operationID, agentID, bootID, id, revision, action, version string) error {
	c, err := s.lifecycleController()
	if err != nil {
		return err
	}
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	key := capabilityMaintenanceKey(scope, id)
	s.capabilityMu.Lock()
	if s.capabilityClosed || !s.capabilityVisible || s.capabilityScope != scope {
		s.capabilityMu.Unlock()
		return errors.New("environment_changed")
	}
	var fact capabilitywatch.Fact
	for _, item := range s.capabilitySnapshot.Facts {
		if item.ID == id && item.Revision == revision {
			fact = item
			break
		}
	}
	updateConfirmed := false
	for _, alert := range s.capabilitySnapshot.Alerts {
		if alert.ID == id && alert.Reason == "npm_update_available" && alert.Version == version && version != "" {
			updateConfirmed = true
		}
	}
	if fact.ID == "" || (action != "remove" && action != "update") ||
		(action == "remove" && version != "") || (action == "update" && (fact.Type != "npm" || !updateConfirmed)) {
		s.capabilityMu.Unlock()
		return errors.New("capability_changed")
	}
	if s.capabilityMaintenance == nil {
		s.capabilityMaintenance = make(map[string]*capabilityMaintenanceEntry)
	}
	if existing := s.capabilityMaintenance[key]; existing != nil && (!maintenanceTerminal(existing.progress.Status) || existing.progress.Status == "succeeded" && existing.revision == revision) {
		s.capabilityMu.Unlock()
		return errors.New("maintenance_busy")
	}
	active := 0
	for _, existing := range s.capabilityMaintenance {
		if sameCapabilityTarget(existing.scope, scope) && !maintenanceTerminal(existing.progress.Status) && existing.progress.Status != "unknown" {
			active++
		}
	}
	if active >= 1 || s.capabilityActions[scope.TargetID+"\x00"+scope.OperationID+"\x00"+scope.AgentID+"\x00"+scope.BootID+"\x00"+id] {
		s.capabilityMu.Unlock()
		return errors.New("maintenance_busy")
	}
	if len(s.capabilityMaintenance) >= 200 {
		for oldKey, old := range s.capabilityMaintenance {
			if maintenanceTerminal(old.progress.Status) {
				delete(s.capabilityMaintenance, oldKey)
				break
			}
		}
		if len(s.capabilityMaintenance) >= 200 {
			s.capabilityMu.Unlock()
			return errors.New("maintenance_busy")
		}
	}
	entry := &capabilityMaintenanceEntry{scope: scope, revision: revision, progress: capabilitywatch.MaintenanceProgress{
		ID: id, Name: fact.Name, Revision: revision, Action: action, Version: version, Status: "executing"}}
	s.capabilityMaintenance[key] = entry
	emit := s.capabilityEmit
	s.capabilityMu.Unlock()
	if emit != nil {
		emit()
	}
	finish := func(status, boot, code string) {
		s.capabilityMu.Lock()
		entry.progress.Status, entry.progress.ErrorCode = status, code
		if boot != "" && boot != scope.BootID {
			delete(s.capabilityMaintenance, key)
			entry.scope.BootID = boot
			entry.progress.Restarted = true
			s.capabilityMaintenance[capabilityMaintenanceKey(entry.scope, id)] = entry
		}
		current, monitor, notify := s.capabilityScope, s.capabilityMonitor, s.capabilityEmit
		s.capabilityMu.Unlock()
		if notify != nil {
			notify()
		}
		if monitor != nil && current.TargetID == scope.TargetID && current.OperationID == scope.OperationID && current.AgentID == scope.AgentID {
			monitor.Refresh(current)
		}
	}
	if err := c.StartLocalCapabilityMaintenance(scope, fact, action, version, finish); err != nil {
		finish("busy", scope.BootID, "")
		return err
	}
	return nil
}

// GetCapabilityMaintenanceAvailability probes the same-user Native command;
// older agents are intentionally read-only in this UI.
func (s *FoundationService) GetCapabilityMaintenanceAvailability(targetID, operationID, agentID, bootID string) bool {
	c, err := s.lifecycleController()
	if err != nil {
		return false
	}
	return c.LocalCapabilityMaintenanceAvailable(capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID})
}
