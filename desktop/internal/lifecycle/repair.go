package lifecycle

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func (c *Controller) Repair(id, operation string, revision uint64) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || s.state.Revision != revision || s.state.Stage != "repair" || !c.validLocked(s) || c.mutation != nil || !oneOf(s.state.Reason, "program_missing", "service_missing", "uninstalled") {
		return Snapshot{}, errors.New("lifecycle_check_required")
	}
	reason := s.state.Reason
	c.beginMutationLocked(s)
	c.publishLocked(s, "repairing", reason, s.facts, nil)
	go c.runRepair(s, reason, s.facts.AgentID)
	return s.state, nil
}
func (c *Controller) runRepair(s *session, reason, expectedAgentID string) {
	ctx, cancel := context.WithTimeout(s.ctx, 4*time.Minute)
	before := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if before.Stage != "repair" || before.Reason != reason && !(reason == "uninstalled" && before.Reason == "program_missing") {
		cancel()
		c.publish(s, before)
		c.endMutation(s)
		c.observe(s, before, false)
		return
	}
	if !c.publish(s, outcome("repairing", reason, before.Facts)) {
		cancel()
		c.endMutation(s)
		return
	}
	err := c.executeRepair(ctx, s, reason, func(stage string) { c.phase(s, stage) })
	after := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	cancel()
	if expectedAgentID != "" && after.Facts.AgentID != "" && expectedAgentID != after.Facts.AgentID ||
		before.Facts.AgentID != "" && after.Facts.AgentID != "" && before.Facts.AgentID != after.Facts.AgentID {
		after = outcome("blocked", "management_identity_mismatch", after.Facts)
	} else if oneOf(reason, "program_missing", "uninstalled") && err == nil && after.Stage == "configure" && after.Facts.AgentID != "" {
		// A restored installation may require browser authorization for its
		// original Agent before the service can be brought online.
	} else if reason == "service_missing" && before.Facts.AgentID != "" && after.Facts.AgentID == before.Facts.AgentID &&
		oneOf(after.Facts.Service, "running", "starting") && oneOf(after.Stage, "ready", "connecting") {
		// A failed reply does not outweigh a verified service and identity.
		// Continue observing; never repeat the registration.
	} else if err != nil && err.Error() == "target_download_failed" {
		after = outcome("blocked", "target_download_failed", before.Facts)
	} else if err != nil || after.Stage == "initialize" || after.Stage == "configure" {
		after = outcome("unknown", "repair_outcome_unconfirmed", after.Facts)
	} else if reason == "service_missing" && after.Stage == "unknown" && after.Reason == "service_identity_unconfirmed" && after.Facts.Service == "unknown" {
		// A successful registration may still be in the supervisor's first spawn.
		after = outcome("connecting", "waiting_for_management", after.Facts)
	}
	if after.Facts.AgentID == "" {
		after.Facts.AgentID = before.Facts.AgentID
	}
	if after.Facts.AgentID == before.Facts.AgentID && (after.Facts.AgentName == "" || after.Facts.AgentName == after.Facts.AgentID) {
		after.Facts.AgentName = before.Facts.AgentName
	}
	if after.Facts.RequiredVersion == "" {
		after.Facts.RequiredVersion = before.Facts.RequiredVersion
	}
	if after.Summary != nil && after.Facts.AgentName != "" {
		after.Summary.Name = after.Facts.AgentName
	}
	if after.Stage == "ready" && after.Facts.RequiredVersion != "" && after.Summary.Version != after.Facts.RequiredVersion {
		after = outcome("upgrade", "version_incompatible", after.Facts)
	}
	c.publish(s, after)
	c.endMutation(s)
	c.observe(s, after, reason == "service_missing")
}
func (c *Controller) executeRepair(ctx context.Context, s *session, reason string, progress func(string)) error {
	var path string
	var args []string
	if oneOf(reason, "program_missing", "uninstalled") {
		version, artifact, e := loadReleaseArtifact(ctx, s.rt, c.origin, c.profile, func(stage string) {
			if progress != nil {
				if stage == "install_manifest" || stage == "install_download" {
					progress("repair_download")
				} else {
					progress("repair_verify")
				}
			}
		})
		if e != nil {
			return e
		}
		if progress != nil {
			progress("repair_download")
		}
		var cleanup func()
		path, cleanup, e = stageTargetDownload(ctx, s.rt, c.origin, c.profile, "/agent/native/"+artifact.Name, artifact.Name, artifact.Size, func(done, total int64) {
			c.phase(s, "repair_download:"+strconv.FormatInt(done, 10)+":"+strconv.FormatInt(total, 10))
		})
		if e != nil {
			return e
		}
		defer cleanup()
		if e = verifyTargetArtifact(ctx, s.rt, path, artifact); e != nil {
			return e
		}
		args = []string{"desktop", "repair-program", "--profile", c.profile, "--server", c.origin, "--expected-version", version}
	} else {
		var why string
		path, _, why = programPath(ctx, s.rt, c.profile)
		if path == "" || why != "" {
			return errors.New("repair_precondition_failed")
		}
		args = []string{"desktop", "repair-service", "--profile", c.profile, "--server", c.origin}
	}
	if progress != nil {
		if oneOf(reason, "program_missing", "uninstalled") {
			progress("repair_apply")
		} else {
			progress("repair_service")
		}
	}
	r, e := s.rt.Run(ctx, environment.Command{Program: path, Args: args, Progress: progress})
	if e != nil || !r.OutcomeKnown || r.Truncated || r.ExitCode != 0 {
		return errors.New("repair_outcome_unconfirmed")
	}
	return nil
}
