package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type capabilityStateWire struct {
	Protocol        int                    `json:"protocol"`
	Profile         string                 `json:"profile"`
	AgentID         string                 `json:"agentId"`
	BootID          string                 `json:"bootId"`
	State           string                 `json:"state"`
	Items           []capabilitywatch.Fact `json:"items"`
	PackageRevision string                 `json:"packageRevision,omitempty"`
}

func validCapabilityGeneration(raw string) bool {
	if raw == "" || len(raw) > 20 || len(raw) > 1 && raw[0] == '0' {
		return false
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	return err == nil && v > 0
}

func validCapabilityState(v capabilityStateWire, profile, agentID, bootID string) bool {
	if v.Protocol != Protocol || v.Profile != profile || v.AgentID != agentID || v.BootID != bootID ||
		!oneOf(v.State, "available", "partial") || v.Items == nil || len(v.Items) > 200 {
		return false
	}
	if v.PackageRevision != "" && !validCapabilityGeneration(v.PackageRevision) {
		return false
	}
	seen := map[string]bool{}
	for _, f := range v.Items {
		if !validCapabilityResourceID(f.ID) || !validText(f.Name, 256) || strings.TrimSpace(f.Name) == "" || seen[f.ID] ||
			!oneOf(f.Type, "mcp", "openapi", "npm") || !oneOf(f.State, "active", "unknown", "failed", "disconnected") {
			return false
		}
		seen[f.ID] = true
		if f.Revision != "" && !validCapabilityResourceID("res_"+f.Revision) {
			return false
		}
		if f.State == "disconnected" && (f.Type != "mcp" || f.Reason != "mcp_disconnected") {
			return false
		}
		if f.PendingConfig && f.Type != "mcp" && f.Type != "openapi" {
			return false
		}
		if (f.State == "active" || f.State == "unknown") && f.Reason != "" {
			return false
		}
		if f.State == "failed" && !oneOf(f.Reason, "source_activation_failed", "mcp_managed_process_unavailable", "source_withdrawal_unconfirmed") && !(f.Type == "npm" && f.Reason == "extension_load_failed") {
			return false
		}
		if f.ObservedAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, f.ObservedAt); err != nil {
				return false
			}
		}
		if f.InstalledVersion != "" || f.Registry != "" || f.Channel != "" {
			return false
		}
	}
	return true
}

// CapabilityState only admits the current lifecycle identity. Cancelling the
// client monitor propagates into the Local/SSH command and drops late results.
func (c *Controller) CapabilityState(parent context.Context, scope capabilitywatch.Scope) (capabilitywatch.Snapshot, error) {
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == scope.TargetID && s.operation == scope.OperationID && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == scope.AgentID && s.state.Summary.BootID == scope.BootID
	c.mu.Unlock()
	if !admitted {
		return capabilitywatch.Snapshot{}, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	stop := context.AfterFunc(parent, cancel)
	defer func() { stop(); cancel() }()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return capabilitywatch.Snapshot{}, errors.New("capability_state_unavailable")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "capability-state", "--profile", c.profile, "--server", c.origin, "--agent-id", scope.AgentID, "--boot-id", scope.BootID,
	}})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 512*1024 {
		return capabilitywatch.Snapshot{}, errors.New("capability_state_unavailable")
	}
	var value capabilityStateWire
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || !validCapabilityState(value, c.profile, scope.AgentID, scope.BootID) {
		return capabilitywatch.Snapshot{}, errors.New("capability_state_unavailable")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return capabilitywatch.Snapshot{}, errors.New("capability_state_unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if parent.Err() != nil || !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil ||
		s.state.Summary.AgentID != scope.AgentID || s.state.Summary.BootID != scope.BootID {
		return capabilitywatch.Snapshot{}, errors.New("environment_changed")
	}
	return capabilitywatch.Snapshot{Scope: scope, State: value.State, Facts: value.Items, Alerts: []capabilitywatch.Alert{}, PackageRevision: value.PackageRevision}, nil
}
