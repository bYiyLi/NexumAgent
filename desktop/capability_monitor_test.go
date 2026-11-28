package main

import (
	"context"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
)

func TestCapabilityQueryStopsOnHideAndTargetLeave(t *testing.T) {
	s := &FoundationService{}
	scope := capabilitywatch.Scope{TargetID: "local", OperationID: "op", AgentID: "agent", BootID: "boot"}
	s.setCapabilityVisible(true)
	s.capabilityMu.Lock()
	s.capabilityScope = scope
	s.resetCapabilityQueryLocked()
	s.capabilityMu.Unlock()
	first, err := s.capabilityQueryContext(scope)
	if err != nil {
		t.Fatal(err)
	}
	s.setCapabilityVisible(false)
	if first.Err() == nil {
		t.Fatal("hide did not cancel the outstanding read")
	}
	if _, err := s.capabilityQueryContext(scope); err == nil {
		t.Fatal("hidden window admitted a read")
	}
	s.setCapabilityVisible(true)
	second, err := s.capabilityQueryContext(scope)
	if err != nil || second == first || second.Err() != nil {
		t.Fatal("visible window did not get a new query context")
	}
	s.StopCapabilityMonitor(scope.TargetID, scope.OperationID, scope.AgentID, scope.BootID)
	if second.Err() == nil {
		t.Fatal("leaving the target did not cancel its read")
	}
	if _, err := s.capabilityQueryContext(scope); err == nil {
		t.Fatal("left target admitted a read")
	}
}

func TestCapabilityDetailViewingCancelsRegistryObservation(t *testing.T) {
	s := &FoundationService{}
	scope := capabilitywatch.Scope{TargetID: "local", OperationID: "op", AgentID: "agent", BootID: "boot"}
	started := make(chan context.Context, 3)
	s.capabilityScope = scope
	s.capabilityMonitor = capabilitywatch.NewScheduler(time.Hour, func(ctx context.Context, _ capabilitywatch.Scope) (capabilitywatch.Snapshot, error) {
		started <- ctx
		<-ctx.Done()
		return capabilitywatch.Snapshot{}, ctx.Err()
	}, nil)
	defer s.capabilityMonitor.Close()
	s.capabilityMonitor.Start(scope)
	s.capabilityMonitor.SetVisible(true)
	var first context.Context
	select {
	case first = <-started:
	case <-time.After(time.Second):
		t.Fatal("first observation did not start")
	}
	if err := s.SetCapabilityDetailViewing(scope.TargetID, scope.OperationID, scope.AgentID, scope.BootID, true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first.Done():
	case <-time.After(time.Second):
		t.Fatal("opening detail did not cancel the previous observation")
	}
	if !s.capabilityDetailOpen {
		t.Fatal("detail state was not recorded")
	}
	if err := s.SetCapabilityDetailViewing(scope.TargetID, scope.OperationID, scope.AgentID, "old-boot", false); err == nil || !s.capabilityDetailOpen {
		t.Fatal("stale target changed detail state")
	}
	if err := s.SetCapabilityDetailViewing(scope.TargetID, scope.OperationID, scope.AgentID, scope.BootID, false); err != nil || s.capabilityDetailOpen {
		t.Fatal("closing detail did not resume registry eligibility")
	}
}
