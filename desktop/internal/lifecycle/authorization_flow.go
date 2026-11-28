package lifecycle

import (
	"context"
	"errors"
	"time"
)

type OpenBrowser func(string) error

func (c *Controller) Authorize(id, operation string, revision uint64, language string, open OpenBrowser) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || s.state.Revision != revision || !oneOf(s.state.Stage, "initialize", "configure") || !c.validLocked(s) || c.mutation != nil || open == nil {
		return Snapshot{}, errors.New("lifecycle_check_required")
	}
	mode := s.state.Stage
	ctx, cancel := context.WithTimeout(s.ctx, 18*time.Minute)
	s.authorizationCancel = cancel
	c.beginMutationLocked(s)
	c.publishLocked(s, "authorizing", "", s.facts, nil)
	go c.runAuthorization(s, mode, language, open, ctx, cancel)
	return s.state, nil
}
func (c *Controller) CancelAuthorization(id, operation string) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || c.mutation != s || !oneOf(s.state.Stage, "authorizing", "waiting") {
		return Snapshot{}, errors.New("authorization_not_cancellable")
	}
	if s.authorizationCancel != nil {
		s.authorizationCancel()
	}
	return s.state, nil
}
func (c *Controller) ReopenAuthorization(id, operation string, open OpenBrowser) error {
	c.mu.Lock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || s.state.Stage != "waiting" || !c.validLocked(s) || s.authorizationURL == "" || open == nil {
		c.mu.Unlock()
		return errors.New("authorization_not_available")
	}
	url := s.authorizationURL
	c.mu.Unlock()
	return open(url)
}
func (c *Controller) runAuthorization(s *session, mode, language string, open OpenBrowser, ctx context.Context, cancel context.CancelFunc) {
	after, observe := c.authorizationOperation(s, mode, language, open, ctx)
	cancel()
	c.mu.Lock()
	s.authorizationCancel = nil
	s.authorizationURL = ""
	c.mu.Unlock()
	c.endMutation(s)
	if observe {
		c.observe(s, after, true)
	}
}
func (c *Controller) authorizationOperation(s *session, mode, language string, open OpenBrowser, ctx context.Context) (final Outcome, monitor bool) {
	fail := func(stage, reason string, f Facts) { c.publish(s, outcome(stage, reason, f)) }
	before := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if mode == "reset" && (before.Stage != "ready" || before.Summary == nil ||
		before.Summary.AgentID != s.maintenanceAgent || before.Summary.BootID != s.maintenanceBoot) {
		fail("blocked", "management_identity_mismatch", before.Facts)
		return
	}
	if mode != "reset" && before.Stage != mode {
		return before, c.publish(s, before) && oneOf(before.Stage, "ready", "connecting", "upgrade")
	}
	// Restore never replaces an installed executable. Until safe restart
	// ownership can be established, do not consume a Cloud authorization.

	var plan installPlan
	if mode == "initialize" {
		var err error
		plan, err = prepareInstall(ctx, s.rt, c.origin, c.profile, func(stage string) { c.phase(s, stage) })
		if err != nil {
			stage := "blocked"
			if err.Error() == "target_download_unconfirmed" {
				stage = "unknown"
			}
			fail(stage, err.Error(), before.Facts)
			return
		}
		defer plan.cleanup()
		c.phase(s, "install_space")
		if err := checkInstallSpace(ctx, s.rt, plan.artifact.Size); err != nil {
			fail("blocked", err.Error(), before.Facts)
			return
		}
		c.phase(s, "install_stage")
	}
	purpose := "initialize"
	if mode == "configure" || mode == "reset" {
		purpose = "restore"
	}
	authorizationAgentID := ""
	if mode == "configure" || mode == "reset" {
		authorizationAgentID = before.Facts.AgentID
	}
	a, err := newAuthorization(ctx, c.origin, c.profile, purpose, s.id, authorizationAgentID, s.rt.Identity(), language)
	if err != nil {
		fail("failed", "authorization_failed", before.Facts)
		return
	}
	defer a.close()
	defer a.cancelRequest()
	c.mu.Lock()
	if !c.validLocked(s) || ctx.Err() != nil {
		c.mu.Unlock()
		fail("failed", "authorization_cancelled", before.Facts)
		return
	}
	s.authorizationURL = a.authorizationURL
	c.publishLocked(s, "waiting", "", before.Facts, nil)
	c.mu.Unlock()
	if err := open(a.authorizationURL); err != nil {
		fail("failed", "authorization_browser_failed", before.Facts)
		return
	}
	result, err := a.wait(ctx)
	if err != nil {
		fail("failed", err.Error(), before.Facts)
		return
	}
	if result.denial != "" {
		fail("failed", "authorization_denied", before.Facts)
		return
	}
	if !time.Now().Before(a.expires) {
		fail("failed", "authorization_expired", before.Facts)
		return
	}
	// Recheck before exchange, because consuming the approval can rotate a
	// registered device's token. No stale target or changed plan may consume it.
	current := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if mode == "reset" {
		if current.Stage != "ready" || current.Summary == nil ||
			current.Summary.AgentID != s.maintenanceAgent || current.Summary.BootID != s.maintenanceBoot {
			fail("unknown", "authorization_target_changed", current.Facts)
			return
		}
		if !c.publish(s, outcome("stopping", "", current.Facts)) {
			return
		}
		state, err := c.resetConnection(ctx, s, a, result.code, s.maintenanceAgent, s.maintenanceBoot)
		if err != nil {
			fail("unknown", err.Error(), current.Facts)
			return
		}
		if state == "busy" {
			c.mu.Lock()
			s.maintenanceBoot = ""
			c.mu.Unlock()
			current.Reason = "maintenance_busy"
			c.publish(s, current)
			return current, true
		}
		after := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
		if after.Summary != nil && (after.Summary.AgentID != s.maintenanceAgent || after.Summary.BootID == s.maintenanceBoot) ||
			after.Facts.AgentID != "" && after.Facts.AgentID != s.maintenanceAgent {
			fail("blocked", "management_identity_mismatch", after.Facts)
			return
		}
		if !oneOf(after.Stage, "ready", "connecting", "upgrade", "start") {
			fail("unknown", "restore_outcome_unknown", after.Facts)
			return
		}
		after.Facts.AgentID = s.maintenanceAgent
		if after.Stage == "start" {
			after = outcome("connecting", "waiting_for_management", after.Facts)
		}
		if !c.publish(s, after) {
			return
		}
		return after, true
	}
	if mode == "initialize" && current.Stage == mode {
		c.phase(s, "install_space")
		if err := checkInstallSpace(ctx, s.rt, plan.artifact.Size); err != nil {
			fail("blocked", err.Error(), current.Facts)
			return
		}
	}
	c.mu.Lock()
	valid := c.validLocked(s) && ctx.Err() == nil && current.Stage == mode
	if valid && mode == "configure" {
		if oneOf(current.Facts.Service, "running", "starting") {
			c.publishLocked(s, "stopping", "", current.Facts, nil)
			c.mu.Unlock()
			stopped := probe(ctx, s.rt, c.profile, c.origin, "stop", func(stage string) { c.phase(s, stage) })
			if stopped.Stage != "stopped" {
				fail("unknown", "service_stop_outcome_unknown", stopped.Facts)
				return
			}
			current = stopped
			c.mu.Lock()
			valid = c.validLocked(s) && ctx.Err() == nil
		} else if (current.Facts.Service != "stopped" && current.Facts.Service != "missing") || current.Facts.Live != nil {
			valid = false
		}
	}
	if valid {
		c.publishLocked(s, "exchanging", "", current.Facts, nil)
	}
	c.mu.Unlock()
	if !valid {
		fail("unknown", "authorization_target_changed", current.Facts)
		return
	}
	if current.Facts.AgentID == "" {
		current.Facts.AgentID = before.Facts.AgentID
	}
	expectedAgentID := before.Facts.AgentID
	if expectedAgentID == "" {
		expectedAgentID = current.Facts.AgentID
	}
	cred, err := a.exchange(ctx, result.code)
	if err != nil {
		fail("unknown", "authorization_exchange_unknown", current.Facts)
		return
	}
	if expectedAgentID != "" && cred.AgentID != expectedAgentID {
		fail("blocked", "management_identity_mismatch", current.Facts)
		return
	}
	c.mu.Lock()
	valid = c.validLocked(s) && ctx.Err() == nil
	c.mu.Unlock()
	if !valid {
		fail("unknown", "authorization_consumed_target_changed", current.Facts)
		return
	}
	phase := "installing"
	if mode == "configure" {
		phase = "restoring"
	}
	if !c.publish(s, outcome(phase, "", current.Facts)) {
		return
	}
	// Authorization has been consumed. Do not replay it on failure.
	if mode == "initialize" {
		err = executeInstall(ctx, s.rt, c.origin, c.profile, plan.scriptPath, plan.version, cred, func(stage string) { c.phase(s, stage) })
	} else {
		err = executeRestore(ctx, s.rt, c.origin, c.profile, cred, func(stage string) { c.phase(s, stage) })
	}
	// The installed runtime and its identity are authoritative, not the
	// installer exit status. Even a failed command may have installed files.
	after := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if mode == "configure" && err == nil && before.Facts.Service == "missing" && before.Facts.AgentID != "" && before.Facts.AgentID == cred.AgentID &&
		after.Stage == "repair" && after.Reason == "service_missing" && after.Facts.AgentID == cred.AgentID {
		c.mu.Lock()
		restoreService := c.validLocked(s) && ctx.Err() == nil
		c.mu.Unlock()
		if restoreService && c.publish(s, outcome("repairing", "service_missing", after.Facts)) {
			err = c.executeRepair(ctx, s, "service_missing", func(stage string) { c.phase(s, stage) })
			after = probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
			if err == nil && after.Stage == "unknown" && after.Reason == "service_identity_unconfirmed" {
				after = outcome("connecting", "waiting_for_management", after.Facts)
			}
		}
	}
	if after.Summary != nil && after.Summary.AgentID != cred.AgentID || after.Facts.AgentID != "" && after.Facts.AgentID != cred.AgentID {
		fail("blocked", "management_identity_mismatch", after.Facts)
		return
	}
	if after.Stage != "ready" && after.Stage != "connecting" && after.Stage != "upgrade" && after.Stage != "repair" && !(err == nil && after.Stage == "start") {
		fail("unknown", "installation_outcome_unknown", after.Facts)
		return
	}
	if after.Facts.AgentID == "" {
		after.Facts.AgentID = cred.AgentID
	}
	if after.Stage == "start" {
		after = outcome("connecting", "waiting_for_management", after.Facts)
	}
	if !c.publish(s, after) {
		return
	}
	return after, true
}
