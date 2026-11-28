package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type localCapabilityRequest struct {
	ResourceID string `json:"resourceId,omitempty"`
	Revision   string `json:"revision,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Action     string `json:"action"`
	Version    string `json:"version,omitempty"`
}
type localCapabilityReceipt struct {
	Protocol int                    `json:"protocol"`
	Profile  string                 `json:"profile"`
	AgentID  string                 `json:"agentId"`
	BootID   string                 `json:"bootId"`
	Request  localCapabilityRequest `json:"request"`
	Result   struct {
		Status          string `json:"status"`
		RestartRequired bool   `json:"restartRequired"`
	} `json:"result"`
}

var capabilityMaintenanceVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

func (c *Controller) localCapabilityCommand(ctx context.Context, s *session, scope capabilitywatch.Scope, req localCapabilityRequest) string {
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return "unavailable"
	}
	args := []string{"desktop", "capability-maintenance", "--profile", c.profile, "--server", c.origin, "--agent-id", scope.AgentID, "--boot-id", scope.BootID, "--capability-action", req.Action}
	if req.Action != "check" {
		args = append(args, "--resource-id", req.ResourceID, "--revision", req.Revision, "--capability-kind", req.Kind)
		if req.Version != "" {
			args = append(args, "--package-version", req.Version)
		}
	}
	result, err := s.rt.Run(ctx, environment.Command{Program: program, Args: args})
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated || len(result.Stdout) > 8192 {
		return "unknown"
	}
	var receipt localCapabilityReceipt
	d := json.NewDecoder(strings.NewReader(result.Stdout))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&receipt) != nil || d.Decode(&extra) != io.EOF || receipt.Protocol != Protocol || receipt.Profile != c.profile || receipt.AgentID != scope.AgentID || receipt.BootID != scope.BootID || receipt.Request != req {
		return "unknown"
	}
	status := receipt.Result.Status
	if req.Action == "check" {
		if receipt.Result.RestartRequired || !oneOf(status, "available", "unavailable") {
			return "unknown"
		}
	} else if !oneOf(status, "succeeded", "failed", "busy", "changed", "unavailable", "unknown") || receipt.Result.RestartRequired != (status == "succeeded" && req.Kind == "npm") {
		return "unknown"
	}
	return status
}

func (c *Controller) capabilitySessionLocked(scope capabilitywatch.Scope) *session {
	s := c.current
	if s == nil || s.id != scope.TargetID || s.operation != scope.OperationID || !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != scope.AgentID || s.state.Summary.BootID != scope.BootID {
		return nil
	}
	return s
}

func (c *Controller) LocalCapabilityMaintenanceAvailable(scope capabilitywatch.Scope) bool {
	c.mu.Lock()
	s := c.capabilitySessionLocked(scope)
	if s == nil || c.mutation != nil {
		c.mu.Unlock()
		return false
	}
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
	defer cancel()
	available := c.localCapabilityCommand(ctx, s, scope, localCapabilityRequest{Action: "check"}) == "available"
	c.mu.Lock()
	defer c.mu.Unlock()
	return available && c.capabilitySessionLocked(scope) == s && c.mutation == nil
}

// StartLocalCapabilityMaintenance reserves the lifecycle before returning to the
// UI. All commands run on the admitted Local/SSH runtime, never on the Cloud.
func (c *Controller) StartLocalCapabilityMaintenance(scope capabilitywatch.Scope, fact capabilitywatch.Fact, action, version string, finish func(status, boot, code string)) error {
	if finish == nil || !validCapabilityResourceID(fact.ID) || !validCapabilityResourceID("res_"+fact.Revision) || !oneOf(fact.Type, "mcp", "openapi", "npm") ||
		(action != "remove" && action != "update") || (action == "remove" && version != "") ||
		(action == "update" && (fact.Type != "npm" || len(version) > 256 || !capabilityMaintenanceVersion.MatchString(version))) {
		return errors.New("capability_changed")
	}
	c.mu.Lock()
	s := c.capabilitySessionLocked(scope)
	if s == nil || c.mutation != nil || s.state.Summary.Cloud != "online" || (fact.Type == "npm" && (s.facts.Live == nil || !s.facts.Live.ExecutionReady)) {
		c.mu.Unlock()
		return errors.New("maintenance_busy")
	}
	before := Outcome{Stage: "ready", Facts: s.facts, Summary: s.state.Summary}
	s.observation++
	c.beginMutationLocked(s)
	c.publishLocked(s, "ready", "", s.facts, s.state.Summary)
	c.mu.Unlock()
	go c.runLocalCapabilityMaintenance(s, scope, before, fact, action, version, finish)
	return nil
}

func (c *Controller) runLocalCapabilityMaintenance(s *session, scope capabilitywatch.Scope, before Outcome, fact capabilitywatch.Fact, action, version string, finish func(string, string, string)) {
	status, boot, code := "unknown", scope.BootID, ""
	latest := before
	defer func() {
		c.publish(s, latest)
		finish(status, boot, code)
		c.endMutation(s)
		if latest.Stage == "ready" {
			go c.observe(s, latest, false)
		}
	}()
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute+20*time.Second)
	defer cancel()
	req := localCapabilityRequest{ResourceID: fact.ID, Revision: fact.Revision, Kind: fact.Type, Action: action, Version: version}
	status = c.localCapabilityCommand(ctx, s, scope, req)
	if status != "succeeded" {
		if status == "unknown" {
			code = "maintenance_outcome_unknown"
		}
		return
	}
	if fact.Type == "npm" {
		// The filesystem mutation is already confirmed. Do not retry it even if
		// stopping or starting the Agent subsequently fails.
		status, code = "unknown", "package_changed_restart_unconfirmed"
		restartCtx, stop := context.WithTimeout(s.ctx, 4*time.Minute)
		defer stop()
		// A new task may have been admitted after the package gate was released.
		// Existing maintenance-stop refuses busy agents, never forcibly kills them.
		fresh := probe(restartCtx, s.rt, c.profile, c.origin, "inspect", nil)
		if fresh.Stage != "ready" || fresh.Summary == nil || fresh.Summary.AgentID != scope.AgentID || fresh.Summary.BootID != scope.BootID || fresh.Facts.Live == nil || !fresh.Facts.Live.CloudOnline {
			latest = fresh
			return
		}
		latest = fresh
		c.publish(s, outcome("stopping", "", fresh.Facts))
		stopped, err := c.stopForMaintenance(restartCtx, s, scope.AgentID, scope.BootID)
		if err != nil {
			latest = outcome("unknown", "maintenance_outcome_unknown", fresh.Facts)
			return
		}
		if stopped == "busy" {
			latest = fresh
			code = "package_changed_restart_busy"
			return
		}
		latest = probe(restartCtx, s.rt, c.profile, c.origin, "inspect", nil)
		if latest.Facts.AgentID == "" {
			latest.Facts.AgentID = scope.AgentID
		}
		if latest.Facts.Service != "stopped" || latest.Facts.Live != nil || latest.Facts.AgentID != scope.AgentID || latest.Stage != "start" {
			latest = outcome("unknown", "maintenance_restart_start_unavailable", latest.Facts)
			return
		}
		c.publish(s, outcome("starting", "", latest.Facts))
		latest = probe(restartCtx, s.rt, c.profile, c.origin, "start", func(stage string) { c.phase(s, stage) })
		if oneOf(latest.Stage, "unknown", "blocked", "network") {
			return
		}
		c.publish(s, outcome("connecting", "waiting_for_management", latest.Facts))
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-restartCtx.Done():
				latest = outcome("unknown", "maintenance_outcome_unknown", latest.Facts)
				return
			case <-ticker.C:
				latest = probe(restartCtx, s.rt, c.profile, c.origin, "observe", nil)
				if latest.Stage != "ready" || latest.Summary == nil {
					continue
				}
				if latest.Summary.AgentID != scope.AgentID || latest.Summary.BootID == scope.BootID || latest.Summary.Version != before.Facts.Version {
					latest = outcome("blocked", "management_identity_mismatch", latest.Facts)
					return
				}
				if latest.Facts.Live == nil || !latest.Facts.Live.ExecutionReady || !latest.Facts.Live.CloudOnline {
					continue
				}
				if before.Summary != nil && before.Summary.Name != "" {
					latest.Facts.AgentName = before.Summary.Name
					latest.Summary.Name = before.Summary.Name
				}
				boot = latest.Summary.BootID
			}
			if boot != scope.BootID {
				break
			}
		}
		scope.BootID = boot
	}
	// Read a fresh complete view after the mutation (and after the new boot
	// for npm). Never interpret a partial inventory as evidence of deletion.
	if !c.publish(s, latest) {
		status, code = "unknown", "maintenance_outcome_unknown"
		return
	}
	verifyCtx, stopVerify := context.WithTimeout(s.ctx, 30*time.Second)
	defer stopVerify()
	state, err := c.CapabilityState(verifyCtx, scope)
	if err != nil {
		status, code = "unknown", "maintenance_verification_unavailable"
		return
	}
	items, complete := state.Facts, state.State == "available"
	if fact.Type == "npm" {
		var packageState string
		items, packageState, err = c.CapabilityPackages(verifyCtx, scope, state.PackageRevision)
		complete = err == nil && packageState == "available"
	}
	if !complete {
		status, code = "unknown", "maintenance_verification_unavailable"
		return
	}
	found := false
	for _, item := range items {
		if item.ID == fact.ID {
			if action == "remove" || item.InstalledVersion != version || item.State != "installed" {
				status, code = "unknown", "maintenance_verification_unavailable"
				return
			}
			found = true
		}
	}
	if action == "update" && !found {
		status, code = "unknown", "maintenance_verification_unavailable"
		return
	}
	status, code = "succeeded", ""
}

// GuardEnvironmentChange serializes disconnect/removal with mutation admission.
// The manager is always reached under the same controller -> manager lock order
// as validLocked. A user must not remove a target while maintenance is admitted.
func (c *Controller) GuardEnvironmentChange(id string, change func() error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("lifecycle_closed")
	}
	if c.mutation != nil && c.mutation.id == id {
		return errors.New("maintenance_busy")
	}
	return change()
}
