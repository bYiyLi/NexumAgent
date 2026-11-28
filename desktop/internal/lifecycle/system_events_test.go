package lifecycle

import (
	"encoding/json"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestSystemEventsRequireCurrentAgentAndRejectUnknownProjection(t *testing.T) {
	kind := "cloud_online"
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		value := WorkspaceSnapshot{
			Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot",
			SystemEvents: &SystemEvents{Items: []SystemEvent{{Time: "2026-11-27T12:00:00Z", Component: "cloud", Kind: kind}}},
		}
		data, _ := json.Marshal(value)
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	if _, err := c.SystemEvents("local", "operation", "agent", "old-boot"); err == nil {
		t.Fatal("accepted an old boot")
	}
	if got, err := c.SystemEvents("local", "operation", "agent", "boot"); err != nil || got.SystemEvents.Items[0].Kind != kind {
		t.Fatalf("events: %+v, %v", got, err)
	}
	kind = "untrusted raw data"
	if _, err := c.SystemEvents("local", "operation", "agent", "boot"); err == nil {
		t.Fatal("accepted an unknown event classification")
	}
}
