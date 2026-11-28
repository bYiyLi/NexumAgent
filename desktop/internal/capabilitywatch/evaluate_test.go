package capabilitywatch

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestEvaluatorUsesConfirmedFactsAndHighestSeverity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprint(w, `{"name":"pkg","version":"1.1.0"}`) }))
	defer server.Close()
	checker := NewNPMChecker()
	checker.baseURL = server.URL
	now := time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC)
	checker.now = func() time.Time { return now }
	e := NewEvaluator(checker)
	e.now = func() time.Time { return now }
	snapshot := Snapshot{Scope: Scope{TargetID: "local", OperationID: "op", AgentID: "agent", BootID: "boot"}, State: "partial", Facts: []Fact{
		{ID: "mcp", Type: "mcp", Revision: "r", State: "disconnected", Reason: "mcp_disconnected"},
		{ID: "api", Type: "openapi", State: "unknown"},
		{ID: "npm", Type: "npm", Name: "pkg", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"},
	}}
	got := e.Evaluate(context.Background(), snapshot)
	if got.Severity != "problem" || len(got.Alerts) != 2 {
		t.Fatalf("mixed = %+v", got)
	}
	first := got.Alerts[0].ObservedAt
	now = now.Add(time.Minute)
	got = e.Evaluate(context.Background(), snapshot)
	if got.Alerts[0].ObservedAt != first {
		t.Fatalf("ongoing incident time changed: %+v", got.Alerts)
	}
	snapshot.Facts = snapshot.Facts[1:]
	got = e.Evaluate(context.Background(), snapshot)
	if got.Severity != "advice" || len(got.Alerts) != 1 {
		t.Fatalf("advice = %+v", got)
	}
	snapshot.Facts[1].Registry = "unknown"
	got = e.Evaluate(context.Background(), snapshot)
	if got.Severity != "" || len(got.Alerts) != 0 {
		t.Fatalf("unknown produced alert: %+v", got)
	}
}

func TestPendingConfigurationAndDisconnectKeepBothAlerts(t *testing.T) {
	e := NewEvaluator(nil)
	value := Snapshot{Scope: Scope{TargetID: "local", OperationID: "op", AgentID: "agent", BootID: "boot"}, Facts: []Fact{
		{ID: "mcp", Type: "mcp", State: "disconnected", Reason: "mcp_disconnected", PendingConfig: true},
		{ID: "api", Type: "openapi", State: "unknown", PendingConfig: true},
	}}
	got := e.Evaluate(context.Background(), value)
	if got.Severity != "problem" || len(got.Alerts) != 3 || got.Alerts[0].Level != "problem" || got.Alerts[1].Reason != "configuration_pending_approval" || got.Alerts[2].Level != "advice" {
		t.Fatalf("mixed alerts = %+v", got)
	}
	value.Facts = value.Facts[1:]
	got = e.Evaluate(context.Background(), value)
	if got.Severity != "advice" || len(got.Alerts) != 1 || got.Alerts[0].Reason != "configuration_pending_approval" {
		t.Fatalf("pending only = %+v", got)
	}
}

func TestRegistryBudgetAndDetailUseCachedUpdates(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/cached/latest" {
			_, _ = fmt.Fprint(w, `{"name":"cached","version":"2.0.0"}`)
			return
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	checker := NewNPMChecker()
	checker.baseURL = server.URL
	cached := PackageReleaseFacts{Name: "cached", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"}
	if _, err := checker.Check(context.Background(), cached); err != nil {
		t.Fatal(err)
	}
	e := NewEvaluator(checker)
	e.registryBudget = 40 * time.Millisecond
	snapshot := Snapshot{Facts: []Fact{
		{ID: "slow", Type: "npm", Name: "slow", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"},
		{ID: "cached", Type: "npm", Name: "cached", InstalledVersion: "1.0.0", Registry: "public", Channel: "latest"},
	}}
	viewing := e.EvaluateCached(context.Background(), snapshot)
	if requests.Load() != 1 || len(viewing.Alerts) != 1 || viewing.Alerts[0].ID != "cached" {
		t.Fatalf("detail used network or lost cached update: %+v", viewing)
	}
	started := time.Now()
	result := e.Evaluate(context.Background(), snapshot)
	if time.Since(started) > time.Second || requests.Load() != 2 || len(result.Alerts) != 1 || result.Alerts[0].ID != "cached" {
		t.Fatalf("slow registry blocked state or lost cached update: %+v", result)
	}
	_ = e.Evaluate(context.Background(), snapshot)
	if requests.Load() != 2 {
		t.Fatal("an unavailable registry was retried immediately")
	}
}
