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

type capabilityPackagesWire struct {
	Protocol int                    `json:"protocol"`
	Profile  string                 `json:"profile"`
	AgentID  string                 `json:"agentId"`
	BootID   string                 `json:"bootId"`
	Revision string                 `json:"revision"`
	State    string                 `json:"state"`
	Items    []capabilitywatch.Fact `json:"items"`
}

var capabilityInstalledVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$`)

func validCapabilityPackages(v capabilityPackagesWire, profile string, scope capabilitywatch.Scope, revision string) bool {
	if v.Protocol != Protocol || v.Profile != profile || v.AgentID != scope.AgentID || v.BootID != scope.BootID || v.Revision != revision ||
		!validCapabilityGeneration(v.Revision) || !oneOf(v.State, "available", "partial") || v.Items == nil || len(v.Items) > 200 {
		return false
	}
	seen := map[string]bool{}
	for _, f := range v.Items {
		if !validCapabilityResourceID(f.ID) || !validText(f.Name, 256) || seen[f.ID] || f.Type != "npm" || !validCapabilityResourceID("res_"+f.Revision) || f.ObservedAt != "" || f.PendingConfig {
			return false
		}
		if f.Registry == "" && f.Channel != "" || f.Registry != "" && (f.Registry != "public" || f.State != "installed" || f.Channel != "latest" && f.Channel != "next") {
			return false
		}
		seen[f.ID] = true
		switch f.State {
		case "installed":
			if f.Reason != "" || len(f.InstalledVersion) > 256 || !capabilityInstalledVersion.MatchString(f.InstalledVersion) {
				return false
			}
		case "missing":
			if f.Reason != "package_missing" || f.InstalledVersion != "" {
				return false
			}
		case "invalid":
			if f.Reason != "package_invalid" || f.InstalledVersion != "" && (len(f.InstalledVersion) > 256 || !capabilityInstalledVersion.MatchString(f.InstalledVersion)) {
				return false
			}
		case "unknown":
			if f.Reason != "" || f.InstalledVersion != "" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func (c *Controller) CapabilityPackages(parent context.Context, scope capabilitywatch.Scope, revision string) ([]capabilitywatch.Fact, string, error) {
	if parent.Err() != nil || !validCapabilityGeneration(revision) {
		return nil, "", errors.New("capability_packages_unavailable")
	}
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == scope.TargetID && s.operation == scope.OperationID && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == scope.AgentID && s.state.Summary.BootID == scope.BootID
	c.mu.Unlock()
	if !admitted {
		return nil, "", errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	stop := context.AfterFunc(parent, cancel)
	defer func() { stop(); cancel() }()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return nil, "", errors.New("capability_packages_unavailable")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{"desktop", "capability-packages", "--profile", c.profile, "--server", c.origin, "--agent-id", scope.AgentID, "--boot-id", scope.BootID}})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 512*1024 {
		return nil, "", errors.New("capability_packages_unavailable")
	}
	var value capabilityPackagesWire
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || !validCapabilityPackages(value, c.profile, scope, revision) {
		return nil, "", errors.New("capability_packages_unavailable")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, "", errors.New("capability_packages_unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if parent.Err() != nil || !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != scope.AgentID || s.state.Summary.BootID != scope.BootID {
		return nil, "", errors.New("environment_changed")
	}
	return value.Items, value.State, nil
}
