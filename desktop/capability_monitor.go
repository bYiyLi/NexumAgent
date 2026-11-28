package main

import (
	"context"
	"errors"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
)

// The query context is tied to both the currently visible window and the
// selected lifecycle session; hiding or leaving cancels in-flight reads.
func (s *FoundationService) resetCapabilityQueryLocked() {
	if s.capabilityQueryStop != nil {
		s.capabilityQueryStop()
		s.capabilityQueryStop = nil
	}
	s.capabilityQueryCtx = nil
	if !s.capabilityClosed && s.capabilityVisible && s.capabilityScope.TargetID != "" {
		s.capabilityQueryCtx, s.capabilityQueryStop = context.WithCancel(context.Background())
	}
}

func (s *FoundationService) capabilityQueryContext(scope capabilitywatch.Scope) (context.Context, error) {
	s.capabilityMu.Lock()
	defer s.capabilityMu.Unlock()
	if s.capabilityClosed || s.capabilityScope != scope || s.capabilityQueryCtx == nil {
		return nil, errors.New("capability_read_unavailable")
	}
	return s.capabilityQueryCtx, nil
}

func (s *FoundationService) StartCapabilityMonitor(targetID, operationID, agentID, bootID string) error {
	c, err := s.lifecycleController()
	if err != nil {
		return err
	}
	s.capabilityControlMu.Lock()
	defer s.capabilityControlMu.Unlock()
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	if targetID == "" || operationID == "" || agentID == "" || bootID == "" {
		return errors.New("lifecycle_check_required")
	}
	s.capabilityMu.Lock()
	if s.capabilityClosed {
		s.capabilityMu.Unlock()
		return errors.New("lifecycle_closed")
	}
	if s.capabilityMonitor == nil {
		checker := capabilitywatch.NewNPMChecker()
		if s.store != nil {
			checker = capabilitywatch.NewNPMChecker(s.store)
		}
		evaluator := capabilitywatch.NewEvaluator(checker)
		var cachedScope, attemptedScope capabilitywatch.Scope
		var cachedRevision, cachedState, attemptedRevision string
		var cachedPackages []capabilitywatch.Fact
		var attemptedAt time.Time
		s.capabilityMonitor = capabilitywatch.NewScheduler(15*time.Second, func(ctx context.Context, scope capabilitywatch.Scope) (capabilitywatch.Snapshot, error) {
			s.capabilityQueryMu.Lock()
			if err := ctx.Err(); err != nil {
				s.capabilityQueryMu.Unlock()
				return capabilitywatch.Snapshot{}, err
			}
			value, err := c.CapabilityState(ctx, scope)
			if err != nil {
				s.capabilityQueryMu.Unlock()
				return capabilitywatch.Snapshot{}, err
			}
			if value.PackageRevision != "" {
				if cachedScope != scope || cachedRevision != value.PackageRevision {
					if attemptedScope != scope || attemptedRevision != value.PackageRevision || time.Since(attemptedAt) >= time.Minute {
						attemptedScope, attemptedRevision, attemptedAt = scope, value.PackageRevision, time.Now()
						items, state, readErr := c.CapabilityPackages(ctx, scope, value.PackageRevision)
						if readErr == nil {
							cachedScope, cachedRevision, cachedState, cachedPackages = scope, value.PackageRevision, state, items
						}
					}
				}
				if cachedScope == scope && cachedRevision == value.PackageRevision {
					value = capabilitywatch.Merge(value, cachedPackages, cachedState)
				} else {
					value.State = "partial"
				}
			}
			s.capabilityQueryMu.Unlock()
			s.capabilityMu.Lock()
			detailOpen := s.capabilityDetailOpen
			s.capabilityMu.Unlock()
			if detailOpen {
				value = evaluator.EvaluateCached(ctx, value)
			} else {
				value = evaluator.Evaluate(ctx, value)
			}
			if err := ctx.Err(); err != nil {
				return capabilitywatch.Snapshot{}, err
			}
			return capabilitywatch.Collapse(value), nil
		}, func(value capabilitywatch.Snapshot) {
			s.capabilityMu.Lock()
			if s.capabilityClosed || s.capabilityScope != value.Scope {
				s.capabilityMu.Unlock()
				return
			}
			s.capabilitySnapshot = value
			emit := s.capabilityEmit
			s.capabilityMu.Unlock()
			if emit != nil {
				emit()
			}
		})
	}
	monitor, visible := s.capabilityMonitor, s.capabilityVisible
	if s.capabilityScope != scope {
		s.capabilityScope = scope
		s.capabilityDetailOpen = false
		s.capabilitySnapshot = capabilitywatch.Snapshot{Scope: scope, State: "loading", Facts: []capabilitywatch.Fact{}, Alerts: []capabilitywatch.Alert{}}
		s.resetCapabilityQueryLocked()
	}
	s.capabilityMu.Unlock()
	monitor.SetVisible(visible)
	monitor.Start(scope)
	return nil
}

func (s *FoundationService) GetCapabilityObservation(targetID, operationID, agentID, bootID string) (capabilitywatch.Snapshot, error) {
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	s.capabilityMu.Lock()
	defer s.capabilityMu.Unlock()
	if s.capabilityClosed || s.capabilityScope != scope || targetID == "" {
		return capabilitywatch.Snapshot{}, errors.New("environment_changed")
	}
	value := s.capabilitySnapshot
	value.Operations = s.capabilityMaintenanceProgressLocked(scope)
	return value, nil
}

func (s *FoundationService) StopCapabilityMonitor(targetID, operationID, agentID, bootID string) {
	s.capabilityControlMu.Lock()
	defer s.capabilityControlMu.Unlock()
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	s.capabilityMu.Lock()
	monitor := s.capabilityMonitor
	if s.capabilityScope == scope {
		s.capabilityScope = capabilitywatch.Scope{}
		s.capabilityDetailOpen = false
		s.capabilitySnapshot = capabilitywatch.Snapshot{}
		s.resetCapabilityQueryLocked()
	}
	s.capabilityMu.Unlock()
	if monitor != nil {
		monitor.Stop(scope)
	}
}

// Opening a detail cancels an in-flight registry request; subsequent state
// observations use only cached version information until the detail closes.
func (s *FoundationService) SetCapabilityDetailViewing(targetID, operationID, agentID, bootID string, viewing bool) error {
	s.capabilityControlMu.Lock()
	defer s.capabilityControlMu.Unlock()
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	s.capabilityMu.Lock()
	if s.capabilityClosed || s.capabilityScope != scope || targetID == "" {
		s.capabilityMu.Unlock()
		return errors.New("environment_changed")
	}
	changed := s.capabilityDetailOpen != viewing
	s.capabilityDetailOpen = viewing
	monitor := s.capabilityMonitor
	s.capabilityMu.Unlock()
	if changed && monitor != nil {
		monitor.Refresh(scope)
	}
	return nil
}

func (s *FoundationService) ReconnectCapability(targetID, operationID, agentID, bootID, id, revision string) (string, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return "unknown", err
	}
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	key := targetID + "\x00" + operationID + "\x00" + agentID + "\x00" + bootID + "\x00" + id
	s.capabilityMu.Lock()
	if s.capabilityClosed || s.capabilityScope != scope {
		s.capabilityMu.Unlock()
		return "unknown", errors.New("environment_changed")
	}
	if entry := s.capabilityMaintenance[capabilityMaintenanceKey(scope, id)]; entry != nil && !maintenanceTerminal(entry.progress.Status) {
		s.capabilityMu.Unlock()
		return "busy", nil
	}
	if s.capabilityActions == nil {
		s.capabilityActions = make(map[string]bool)
	}
	if s.capabilityUnknown == nil {
		s.capabilityUnknown = make(map[string]bool)
	}
	if s.capabilityUnknown[key] {
		s.capabilityMu.Unlock()
		return "unknown", nil
	}
	if s.capabilityActions[key] {
		s.capabilityMu.Unlock()
		return "busy", nil
	}
	s.capabilityActions[key] = true
	s.capabilityMu.Unlock()
	defer func() { s.capabilityMu.Lock(); delete(s.capabilityActions, key); s.capabilityMu.Unlock() }()
	status, err := c.ReconnectCapability(scope, id, revision)
	s.capabilityMu.Lock()
	if status == "unknown" {
		s.capabilityUnknown[key] = true
	}
	monitor := s.capabilityMonitor
	s.capabilityMu.Unlock()
	if monitor != nil {
		monitor.Refresh(scope)
	}
	return status, err
}

func (s *FoundationService) setCapabilityVisible(visible bool) {
	s.capabilityControlMu.Lock()
	defer s.capabilityControlMu.Unlock()
	s.capabilityMu.Lock()
	if s.capabilityVisible != visible {
		s.capabilityVisible = visible
		s.resetCapabilityQueryLocked()
	}
	monitor := s.capabilityMonitor
	s.capabilityMu.Unlock()
	if monitor != nil {
		monitor.SetVisible(visible)
	}
}

func (s *FoundationService) closeCapabilityMonitor() {
	s.capabilityControlMu.Lock()
	defer s.capabilityControlMu.Unlock()
	s.capabilityMu.Lock()
	s.capabilityClosed = true
	s.resetCapabilityQueryLocked()
	monitor := s.capabilityMonitor
	s.capabilityMu.Unlock()
	if monitor != nil {
		monitor.Close()
	}
}
