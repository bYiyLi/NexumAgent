package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

type testMaterialReader struct {
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (r *testMaterialReader) OnlineMaterialsContext(ctx context.Context, _, _, _, _, _, _, _ string) (lifecycle.WorkspaceSnapshot, error) {
	if r.calls.Add(1) == 1 {
		close(r.started)
		select {
		case <-ctx.Done():
			return lifecycle.WorkspaceSnapshot{}, ctx.Err()
		case <-r.release:
		}
	}
	return lifecycle.WorkspaceSnapshot{Materials: &lifecycle.MaterialsView{List: &lifecycle.MaterialList{
		Complete: true, Items: []lifecycle.MaterialItem{{ID: "item", Kind: "script", Name: "broken.js", Problem: "invalid_input_schema"}},
	}}}, nil
}

func (r *testMaterialReader) SkillEvidence(context.Context, string, string, string, string, bool) ([]lifecycle.SkillEvidence, error) {
	return []lifecycle.SkillEvidence{}, nil
}

func (r *testMaterialReader) MaterialsOnline(string, string, string, string) bool { return true }

func TestMaterialMonitorSerializesRefreshAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	m := &materialMonitor{key: MaterialOverview{TargetID: "local"}, refresh: make(chan struct{}, 1)}
	reader := &testMaterialReader{started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { m.run(ctx, reader); close(done) }()
	<-reader.started
	m.requestRefresh()
	m.requestRefresh()
	if reader.calls.Load() != 1 {
		t.Fatal("refresh overlapped the running read")
	}
	close(reader.release)
	deadline := time.After(3 * time.Second)
	for reader.calls.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("queued refresh did not run")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("monitor did not stop")
	}
	if reader.calls.Load() != 2 {
		t.Fatalf("duplicate refreshes were not coalesced: %d", reader.calls.Load())
	}
}

func TestMaterialMonitorDoesNotPublishAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	m := &materialMonitor{key: MaterialOverview{TargetID: "local"}, refresh: make(chan struct{}, 1)}
	reader := &testMaterialReader{started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { m.run(ctx, reader); close(done) }()
	<-reader.started
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled read did not stop")
	}
	if got := m.snapshot(); got.State != "" || len(got.Items) != 0 {
		t.Fatalf("cancelled result was published: %+v", got)
	}
}

func TestMaterialMonitorStopsOnlyForItsTargetOperation(t *testing.T) {
	var stopped atomic.Bool
	s := &FoundationService{materials: &materialMonitor{
		key:    MaterialOverview{TargetID: "local", OperationID: "new"},
		cancel: func() { stopped.Store(true) },
	}}
	s.stopMaterialsTarget("local", "old")
	if stopped.Load() || s.materials == nil {
		t.Fatal("a stale target operation stopped the current monitor")
	}
	s.stopMaterialsTarget("local", "new")
	if !stopped.Load() || s.materials != nil {
		t.Fatal("the current target monitor was not stopped")
	}
}
