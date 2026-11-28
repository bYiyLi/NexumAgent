package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type capabilityReconnectWire struct {
	Protocol   int    `json:"protocol"`
	Profile    string `json:"profile"`
	AgentID    string `json:"agentId"`
	BootID     string `json:"bootId"`
	ResourceID string `json:"resourceId"`
	Revision   string `json:"revision"`
	Status     string `json:"status"`
}

func (c *Controller) ReconnectCapability(scope capabilitywatch.Scope, id, revision string) (string, error) {
	if !validCapabilityResourceID(id) || !validCapabilityResourceID("res_"+revision) {
		return "unknown", errors.New("capability_reconnect_unavailable")
	}
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == scope.TargetID && s.operation == scope.OperationID && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == scope.AgentID && s.state.Summary.BootID == scope.BootID
	c.mu.Unlock()
	if !admitted {
		return "unknown", errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 75*time.Second)
	defer cancel()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return "unknown", errors.New("capability_reconnect_unavailable")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "capability-reconnect", "--profile", c.profile, "--server", c.origin, "--agent-id", scope.AgentID, "--boot-id", scope.BootID, "--resource-id", id, "--revision", revision,
	}})
	// A lost SSH/IPC response, timeout or non-zero exit may follow a side
	// effect. Never replay it or turn it into a success/failure assertion.
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 8192 {
		return "unknown", nil
	}
	var value capabilityReconnectWire
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || value.Protocol != Protocol || value.Profile != c.profile || value.AgentID != scope.AgentID || value.BootID != scope.BootID ||
		value.ResourceID != id || value.Revision != revision || !oneOf(value.Status, "succeeded", "busy", "changed", "unknown") {
		return "unknown", nil
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return "unknown", nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != scope.AgentID || s.state.Summary.BootID != scope.BootID {
		return "unknown", nil
	}
	return value.Status, nil
}
