package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

const (
	cloudStatusInterval = 5 * time.Second
	cloudStatusMaxAge   = 12 * time.Second
)

// observeCloud is Desktop-owned polling. It never changes Agent admission or
// its WebSocket; old Native/Cloud versions and unreachable endpoints are unknown.
func (c *Controller) observeCloud(s *session, generation uint64) {
	for {
		c.mu.Lock()
		if !c.validLocked(s) || s.observation != generation {
			c.mu.Unlock()
			return
		}
		agentID, bootID := "", ""
		if c.mutation == nil && s.state.Stage == "ready" && s.state.Summary != nil {
			agentID, bootID = s.state.Summary.AgentID, s.state.Summary.BootID
		}
		c.mu.Unlock()
		if agentID != "" && bootID != "" {
			ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
			status := c.readCloudStatus(ctx, s, agentID, bootID)
			cancel()
			c.mu.Lock()
			if !c.validLocked(s) || s.observation != generation {
				c.mu.Unlock()
				return
			}
			if c.mutation == nil && s.state.Stage == "ready" && s.state.Summary != nil &&
				s.state.Summary.AgentID == agentID && s.state.Summary.BootID == bootID {
				s.cloudAgent, s.cloudBoot, s.cloudState, s.cloudObserved = agentID, bootID, status, time.Now()
				c.publishLocked(s, s.state.Stage, s.state.Reason, s.facts, s.state.Summary)
			}
			c.mu.Unlock()
		}
		timer := time.NewTimer(cloudStatusInterval)
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (c *Controller) readCloudStatus(ctx context.Context, s *session, agentID, bootID string) string {
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return "unknown"
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "cloud-status", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
	}})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 4096 {
		return "unknown"
	}
	var value maintenanceStopResult
	var extra any
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || decoder.Decode(&extra) != io.EOF || value.Protocol != Protocol ||
		value.Profile != c.profile || value.AgentID != agentID || value.BootID != bootID || !oneOf(value.State, "online", "offline", "unknown") {
		return "unknown"
	}
	return value.State
}
