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

func (c *Controller) MaintenanceAvailable(id, operation, agentID, bootID string) (bool, error) {
	s := c.workspaceSession(id, operation, agentID, bootID)
	if s == nil {
		return false, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return false, errors.New("maintenance_unavailable")
	}
	result, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "maintenance-check", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
	}})
	var value maintenanceStopResult
	var extra any
	decoder := json.NewDecoder(strings.NewReader(result.Stdout))
	decoder.DisallowUnknownFields()
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated ||
		decoder.Decode(&value) != nil || decoder.Decode(&extra) != io.EOF ||
		value.Protocol != Protocol || value.Profile != c.profile || value.AgentID != agentID ||
		value.BootID != bootID || value.State != "available" {
		return false, errors.New("maintenance_unavailable")
	}
	if c.workspaceSession(id, operation, agentID, bootID) != s {
		return false, errors.New("environment_changed")
	}
	return true, nil
}
