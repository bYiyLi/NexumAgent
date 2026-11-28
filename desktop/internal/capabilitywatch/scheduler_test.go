package capabilitywatch

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func waitValue[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
		var zero T
		return zero
	}
}

func expectQuiet[T any](t *testing.T, ch <-chan T) {
	t.Helper()
	select {
	case value := <-ch:
		t.Fatalf("unexpected value: %+v", value)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSchedulerCancelsHiddenAndChangedTargets(t *testing.T) {
	started := make(chan Scope, 8)
	results := make(chan Snapshot, 8)
	release := make(chan struct{}, 8)
	var concurrent, maximum atomic.Int32
	read := func(ctx context.Context, scope Scope) (Snapshot, error) {
		active := concurrent.Add(1)
		defer concurrent.Add(-1)
		if active > maximum.Load() {
			maximum.Store(active)
		}
		started <- scope
		select {
		case <-release:
			return Snapshot{State: "available"}, nil
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		}
	}
	s := NewScheduler(time.Hour, read, func(v Snapshot) { results <- v })
	defer s.Close()
	a := Scope{TargetID: "local", OperationID: "op1", AgentID: "a", BootID: "boot1"}
	b := Scope{TargetID: "remote", OperationID: "op2", AgentID: "b", BootID: "boot2"}
	s.Start(a)
	expectQuiet(t, started)
	s.SetVisible(true)
	if got := waitValue(t, started); got != a {
		t.Fatalf("scope: %+v", got)
	}
	s.SetVisible(false)
	expectQuiet(t, results)
	expectQuiet(t, started)
	s.SetVisible(true)
	if got := waitValue(t, started); got != a {
		t.Fatalf("scope: %+v", got)
	}
	s.Start(b)
	if got := waitValue(t, started); got != b {
		t.Fatalf("scope: %+v", got)
	}
	release <- struct{}{}
	if got := waitValue(t, results); got.Scope != b || got.State != "available" {
		t.Fatalf("result: %+v", got)
	}
	expectQuiet(t, started)
	s.Stop(a) // an old unmount must not stop the new session
	s.Refresh(b)
	if got := waitValue(t, started); got != b {
		t.Fatalf("scope: %+v", got)
	}
	s.Stop(b)
	expectQuiet(t, results)
	expectQuiet(t, started)
	if maximum.Load() != 1 {
		t.Fatalf("parallel reads: %d", maximum.Load())
	}
}

func TestSchedulerSerializesTicksAndClearsFailedObservation(t *testing.T) {
	started := make(chan struct{}, 8)
	release := make(chan struct{}, 8)
	results := make(chan Snapshot, 8)
	var calls atomic.Int32
	scope := Scope{TargetID: "local", OperationID: "op", AgentID: "a", BootID: "boot"}
	s := NewScheduler(20*time.Millisecond, func(ctx context.Context, _ Scope) (Snapshot, error) {
		call := calls.Add(1)
		started <- struct{}{}
		select {
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		case <-release:
		}
		if call == 2 {
			return Snapshot{}, errors.New("unavailable")
		}
		return Snapshot{State: "available", Alerts: []Alert{{Level: "problem"}}}, nil
	}, func(v Snapshot) { results <- v })
	defer s.Close()
	s.Start(scope)
	s.SetVisible(true)
	waitValue(t, started)
	expectQuiet(t, started) // a slow read cannot overlap another tick
	release <- struct{}{}
	waitValue(t, results)
	waitValue(t, started)
	release <- struct{}{}
	got := waitValue(t, results)
	if got.State != "unavailable" || len(got.Alerts) != 0 {
		t.Fatalf("stale alert after failure: %+v", got)
	}
	s.Stop(scope)
}
