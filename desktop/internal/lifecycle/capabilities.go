package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type Capability struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type CapabilityInventory struct {
	Protocol    int          `json:"protocol"`
	Profile     string       `json:"profile"`
	TargetID    string       `json:"targetId"`
	OperationID string       `json:"operationId"`
	AgentID     string       `json:"agentId"`
	BootID      string       `json:"bootId"`
	State       string       `json:"state"`
	Items       []Capability `json:"items"`
}

func validCapabilities(v CapabilityInventory, profile, agentID, bootID string) bool {
	if v.Protocol != Protocol || v.Profile != profile || v.AgentID != agentID || v.BootID != bootID ||
		!oneOf(v.State, "available", "partial") || v.Items == nil || len(v.Items) > 200 {
		return false
	}
	seen := map[string]bool{}
	for _, item := range v.Items {
		if !validText(item.ID, 256) || !validText(item.Name, 256) || strings.TrimSpace(item.Name) == "" ||
			!oneOf(item.Type, "mcp", "openapi", "npm") || seen[item.ID] {
			return false
		}
		seen[item.ID] = true
	}
	return true
}

// The lifecycle controller owns admission only. Capability reads use its same
// authenticated Runtime and boot, and never inspect Agent state files directly.
func (c *Controller) Capabilities(id, operation, agentID, bootID string) (CapabilityInventory, error) {
	return c.CapabilitiesContext(context.Background(), id, operation, agentID, bootID)
}

func (c *Controller) CapabilitiesContext(parent context.Context, id, operation, agentID, bootID string) (CapabilityInventory, error) {
	if err := parent.Err(); err != nil {
		return CapabilityInventory{}, err
	}
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == id && s.operation == operation && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == agentID && s.state.Summary.BootID == bootID
	c.mu.Unlock()
	if !admitted {
		return CapabilityInventory{}, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	stop := context.AfterFunc(parent, cancel)
	defer func() { stop(); cancel() }()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return CapabilityInventory{}, errors.New("capabilities_unavailable")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "capabilities", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
	}})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated {
		return CapabilityInventory{}, errors.New("capabilities_unavailable")
	}
	var result CapabilityInventory
	d := json.NewDecoder(strings.NewReader(res.Stdout))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || result.TargetID != "" || result.OperationID != "" || !validCapabilities(result, c.profile, agentID, bootID) {
		return CapabilityInventory{}, errors.New("capabilities_unavailable")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return CapabilityInventory{}, errors.New("capabilities_unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if parent.Err() != nil || !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil ||
		s.state.Summary.AgentID != agentID || s.state.Summary.BootID != bootID {
		return CapabilityInventory{}, errors.New("environment_changed")
	}
	result.TargetID, result.OperationID = id, operation
	return result, nil
}
