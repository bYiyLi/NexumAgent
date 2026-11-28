package lifecycle

import (
	"context"
	"time"
)

// SystemEvent is the Agent's bounded, redacted system diagnostic projection.
type SystemEvent struct {
	Time      string `json:"time"`
	Component string `json:"component"`
	Kind      string `json:"kind"`
}

type SystemEvents struct {
	Items   []SystemEvent `json:"items"`
	Partial bool          `json:"partial"`
}

func systemEventsValid(events *SystemEvents) bool {
	if events == nil || events.Items == nil || len(events.Items) > 20 {
		return false
	}
	for _, event := range events.Items {
		if _, err := time.Parse(time.RFC3339Nano, event.Time); err != nil ||
			!oneOf(event.Component, "agent", "cloud", "node_host", "storage") ||
			!oneOf(event.Kind, "component_failed", "cloud_online", "cloud_offline", "host_ready", "host_not_ready") {
			return false
		}
	}
	return true
}

func (c *Controller) SystemEvents(id, operation, agentID, bootID string) (WorkspaceSnapshot, error) {
	return c.readWorkspace(context.Background(), id, operation, agentID, bootID, "system-events", "", "", "")
}
