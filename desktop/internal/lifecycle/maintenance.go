package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type maintenanceStopResult struct {
	Protocol int    `json:"protocol"`
	Profile  string `json:"profile"`
	AgentID  string `json:"agentId"`
	BootID   string `json:"bootId"`
	State    string `json:"state"`
}

// BeginAgentMaintenance binds the confirmed action to the current target,
// lifecycle revision, and running Agent identity.
func (c *Controller) BeginAgentMaintenance(id, operation string, revision uint64, agentID, bootID, action, language string, open OpenBrowser) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || s.state.Revision != revision ||
		s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != agentID ||
		s.state.Summary.BootID != bootID || !oneOf(action, "restart", "stop", "reset", "reinstall", "uninstall") ||
		action == "reset" && open == nil || !c.validLocked(s) || c.mutation != nil {
		return Snapshot{}, errors.New("lifecycle_check_required")
	}
	// The existing start contract needs Cloud to verify the saved credential.
	// Do not stop a healthy Agent for a restart that cannot be started again.
	if action == "restart" && s.state.Summary.Cloud != "online" {
		return Snapshot{}, errors.New("maintenance_cloud_required")
	}
	before := Outcome{Stage: "ready", Reason: s.state.Reason, Facts: s.facts, Summary: s.state.Summary}
	s.observation++
	c.beginMutationLocked(s)
	if action == "reset" {
		s.maintenanceAgent, s.maintenanceBoot = agentID, bootID
		ctx, cancel := context.WithTimeout(s.ctx, 18*time.Minute)
		s.authorizationCancel = cancel
		c.publishLocked(s, "authorizing", "", s.facts, nil)
		go c.runAuthorization(s, "reset", language, open, ctx, cancel)
		return s.state, nil
	}
	if action == "reinstall" || action == "uninstall" {
		c.publishLocked(s, "install_manifest", "", s.facts, nil)
		go c.runInstallChange(s, action, agentID, bootID, before)
		return s.state, nil
	}
	c.publishLocked(s, "stopping", "", s.facts, nil)
	go c.runMaintenance(s, action, agentID, bootID, before)
	return s.state, nil
}

func (c *Controller) runMaintenance(s *session, action, agentID, bootID string, before Outcome) {
	ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
	defer cancel()
	stopped, err := c.stopForMaintenance(ctx, s, agentID, bootID)
	if err != nil {
		c.publish(s, outcome("unknown", "maintenance_outcome_unknown", before.Facts))
		c.endMutation(s)
		return
	}
	if stopped == "busy" {
		before.Reason = "maintenance_busy"
		c.publish(s, before)
		c.endMutation(s)
		c.observe(s, before, false)
		return
	}
	after := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if after.Facts.AgentID == "" {
		after.Facts.AgentID = agentID
	}
	if after.Facts.Service != "stopped" || after.Facts.Live != nil || after.Facts.AgentID != agentID {
		c.publish(s, outcome("unknown", "maintenance_outcome_unknown", after.Facts))
		c.endMutation(s)
		return
	}
	if action == "stop" {
		c.publish(s, outcome("start", "service_stopped", after.Facts))
		c.endMutation(s)
		return
	}
	if after.Stage != "start" {
		c.publish(s, outcome("unknown", "maintenance_restart_start_unavailable", after.Facts))
		c.endMutation(s)
		return
	}
	c.publish(s, outcome("starting", "", after.Facts))
	after = probe(ctx, s.rt, c.profile, c.origin, "start", func(stage string) { c.phase(s, stage) })
	if after.Stage == "unknown" || after.Stage == "blocked" || after.Stage == "network" {
		c.publish(s, outcome("unknown", "maintenance_outcome_unknown", after.Facts))
		c.endMutation(s)
		return
	}
	c.publish(s, outcome("connecting", "waiting_for_management", after.Facts))
	c.waitForMaintenanceReady(ctx, s, agentID, bootID, before.Facts.Version, before, after)
}

func (c *Controller) waitForMaintenanceReady(ctx context.Context, s *session, agentID, bootID, version string, before, after Outcome) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.publish(s, outcome("unknown", "maintenance_outcome_unknown", after.Facts))
			c.endMutation(s)
			return
		case <-ticker.C:
			after = probe(ctx, s.rt, c.profile, c.origin, "observe", nil)
			if after.Stage != "ready" || after.Summary == nil {
				continue
			}
			if after.Summary.AgentID != agentID || after.Summary.BootID == bootID || after.Summary.Version != version {
				c.publish(s, outcome("blocked", "management_identity_mismatch", after.Facts))
				c.endMutation(s)
				return
			}
			name := before.Facts.AgentName
			if before.Summary != nil && before.Summary.AgentID == agentID && before.Summary.Name != "" {
				name = before.Summary.Name
			}
			if name != "" {
				after.Facts.AgentName, after.Summary.Name = name, name
			}
			c.publish(s, after)
			c.endMutation(s)
			c.observe(s, after, false)
			return
		}
	}
}

func (c *Controller) runInstallChange(s *session, action, agentID, bootID string, before Outcome) {
	timeout := 4 * time.Minute
	if action == "reinstall" {
		timeout = 22 * time.Minute
	}
	ctx, cancel := context.WithTimeout(s.ctx, timeout)
	defer cancel()
	version, artifact, err := loadReleaseArtifact(ctx, s.rt, c.origin, c.profile, func(stage string) { c.phase(s, stage) })
	if err != nil {
		c.publish(s, outcome("blocked", "target_download_failed", before.Facts))
		c.endMutation(s)
		return
	}
	c.phase(s, "install_download")
	path, cleanup, err := stageTargetDownload(ctx, s.rt, c.origin, c.profile, "/agent/native/"+artifact.Name, artifact.Name, artifact.Size, func(done, total int64) {
		c.phase(s, "install_download:"+strconv.FormatInt(done, 10)+":"+strconv.FormatInt(total, 10))
	})
	if err != nil {
		stage := "blocked"
		if err.Error() == "target_download_unconfirmed" {
			stage = "unknown"
		}
		c.publish(s, outcome(stage, err.Error(), before.Facts))
		c.endMutation(s)
		return
	}
	defer cleanup()
	c.phase(s, "install_verify")
	if err := verifyTargetArtifact(ctx, s.rt, path, artifact); err != nil {
		c.publish(s, outcome("blocked", "repair_artifact_unverified", before.Facts))
		c.endMutation(s)
		return
	}
	command := "maintenance-reinstall"
	if action == "uninstall" {
		command = "maintenance-uninstall"
		c.phase(s, "stopping")
	} else {
		c.phase(s, "reinstall_prepare")
	}
	args := []string{"desktop", command, "--profile", c.profile, "--server", c.origin,
		"--expected-version", version, "--agent-id", agentID, "--boot-id", bootID}
	// Do not silently fall back to an old, Native-only reinstall helper.
	if action == "reinstall" {
		args = append(args, "--full-runtime")
	}
	result, err := s.rt.Run(ctx, environment.Command{Program: path, Args: args, Progress: func(stage string) { c.phase(s, stage) }})
	outcomeResult := maintenanceCommandResult{result: result, err: err}
	if validateMaintenanceResult(outcomeResult, c.profile, agentID, bootID, "busy") {
		before.Reason = "maintenance_busy"
		c.publish(s, before)
		c.endMutation(s)
		c.observe(s, before, false)
		return
	}
	if action == "reinstall" {
		for _, reason := range []string{"runtime_prepare_failed", "runtime_recovery_required"} {
			if validateMaintenanceResult(outcomeResult, c.profile, agentID, bootID, reason) {
				c.publish(s, outcome("blocked", reason, before.Facts))
				c.endMutation(s)
				return
			}
		}
	}
	expectedState := "started"
	if action == "uninstall" {
		expectedState = "removed"
	}
	if !validateMaintenanceResult(outcomeResult, c.profile, agentID, bootID, expectedState) {
		c.publish(s, outcome("unknown", "maintenance_outcome_unknown", before.Facts))
		c.endMutation(s)
		return
	}
	if action == "uninstall" {
		installed, facts, reason := programPath(ctx, s.rt, c.profile)
		if installed != "" || reason != "" || facts.Root != "present" || facts.Program != "missing" {
			c.publish(s, outcome("unknown", "maintenance_outcome_unknown", before.Facts))
			c.endMutation(s)
			return
		}
		facts.AgentID, facts.AgentName, facts.Service = agentID, before.Facts.AgentName, "missing"
		c.publish(s, outcome("repair", "uninstalled", facts))
		c.endMutation(s)
		return
	}
	after := outcome("connecting", "waiting_for_management", before.Facts)
	c.publish(s, after)
	c.waitForMaintenanceReady(ctx, s, agentID, bootID, version, before, after)
}

func (c *Controller) stopForMaintenance(ctx context.Context, s *session, agentID, bootID string) (string, error) {
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return "", errors.New("maintenance_outcome_unknown")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "maintenance-stop", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
	}})
	var stopped maintenanceStopResult
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	var extra any
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated ||
		decoder.Decode(&stopped) != nil || decoder.Decode(&extra) != io.EOF ||
		stopped.Protocol != Protocol || stopped.Profile != c.profile || stopped.AgentID != agentID || stopped.BootID != bootID ||
		!oneOf(stopped.State, "stopped", "busy") {
		return "", errors.New("maintenance_outcome_unknown")
	}
	return stopped.State, nil
}
