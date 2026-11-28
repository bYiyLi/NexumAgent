package capabilitywatch

import (
	"context"
	"testing"
)

func TestMergeKeepsBothPackageAndExtensionAlerts(t *testing.T) {
	base := Snapshot{State: "available", Facts: []Fact{{ID: "id", Name: "pkg", Type: "npm", Revision: "extension", State: "failed", Reason: "extension_load_failed"}}}
	packageFact := Fact{ID: "id", Name: "pkg", Type: "npm", Revision: "manifest", State: "missing", Reason: "package_missing"}
	merged := Merge(base, []Fact{packageFact}, "available")
	merged = NewEvaluator(nil).Evaluate(context.Background(), merged)
	merged = Collapse(merged)
	if merged.Severity != "problem" || len(merged.Alerts) != 2 || len(merged.Facts) != 1 || merged.Facts[0].Revision != "manifest" {
		t.Fatalf("merged: %+v", merged)
	}
	conflict := Merge(base, []Fact{{ID: "id", Name: "different", Type: "npm"}}, "available")
	if conflict.State != "partial" || len(conflict.Facts) != 1 {
		t.Fatalf("identity conflict: %+v", conflict)
	}
}
