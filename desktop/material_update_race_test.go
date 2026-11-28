package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

type changingMaterialReader struct{ reads atomic.Int32 }

func (r *changingMaterialReader) OnlineMaterialsContext(context.Context, string, string, string, string, string, string, string) (lifecycle.WorkspaceSnapshot, error) {
	revision := "new"
	if r.reads.Add(1) == 1 {
		revision = "old"
	}
	return lifecycle.WorkspaceSnapshot{Materials: &lifecycle.MaterialsView{List: &lifecycle.MaterialList{
		Complete: true, Items: []lifecycle.MaterialItem{{ID: "skill", Kind: "skill", Name: "fixture", Source: "personal", Revision: revision}},
	}}}, nil
}

func (r *changingMaterialReader) SkillEvidence(_ context.Context, _, _, _, _ string, missingOnly bool) ([]lifecycle.SkillEvidence, error) {
	if missingOnly {
		return []lifecycle.SkillEvidence{}, nil
	}
	return []lifecycle.SkillEvidence{{ID: "skill"}}, nil
}

func (r *changingMaterialReader) MaterialsOnline(string, string, string, string) bool { return true }

func TestMaterialMonitorRetriesUpdateCheckAfterInventoryChanges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := &changingMaterialReader{}
	var checks atomic.Int32
	m := &materialMonitor{key: MaterialOverview{TargetID: "local"}, refresh: make(chan struct{}, 1),
		checkUpdates: func(context.Context, []lifecycle.SkillEvidence) map[string]skillUpdate {
			checks.Add(1)
			return map[string]skillUpdate{"skill": {notice: "update", checked: true, available: "new-upstream"}}
		}}
	done := make(chan struct{})
	go func() { m.run(ctx, reader); close(done) }()
	deadline := time.After(3 * time.Second)
	for {
		value := m.snapshot()
		if checks.Load() >= 2 && len(value.Items) == 1 && value.Items[0].Revision == "new" && value.Items[0].Notice == "update" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("update check was not retried after an inventory change: checks=%d snapshot=%+v", checks.Load(), value)
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
}
