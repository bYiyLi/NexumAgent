package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

var removalToken = regexp.MustCompile(`^[a-f0-9]{64}$`)

type MaterialRemoval struct {
	Action     string `json:"action"`
	Kind       string `json:"kind"`
	ResourceID string `json:"resourceId"`
	Name       string `json:"name"`
	Location   string `json:"location,omitempty"`
	Token      string `json:"token,omitempty"`
	ExpiresAt  string `json:"expiresAt,omitempty"`
}

func (c *Controller) RemoveMaterial(id, operation, agentID, bootID, action, kind, resourceID, token string) (MaterialRemoval, error) {
	var zero MaterialRemoval
	if !oneOf(kind, "skill", "script") || !validCapabilityResourceID(resourceID) ||
		(action != "prepare" && action != "commit") || action == "prepare" && token != "" || action == "commit" && !removalToken.MatchString(token) {
		return zero, errors.New("invalid_material_removal")
	}
	s := c.workspaceSession(id, operation, agentID, bootID)
	if s == nil || !c.materialsOnline(id, operation, agentID, bootID) {
		return zero, errors.New("materials_unavailable")
	}
	if action == "prepare" {
		// Every new confirmation starts from a fresh read of the same target.
		// This also prevents a retry from using a stale row after a lost result.
		view, err := c.OnlineMaterialsContext(context.Background(), id, operation, agentID, bootID, "", "", "")
		if err != nil || view.Materials == nil || view.Materials.List == nil {
			return zero, errors.New("materials_unavailable")
		}
		found := false
		for _, item := range view.Materials.List.Items {
			found = found || item.ID == resourceID && item.Kind == kind && item.CanRemove
		}
		if !found {
			return zero, errors.New("material_removal_unavailable")
		}
	}
	unknown := func() (MaterialRemoval, error) {
		// Read the original target, but never replay a possibly completed commit.
		_, _ = c.OnlineMaterialsContext(context.Background(), id, operation, agentID, bootID, "", "", "")
		return zero, errors.New("material_removal_outcome_unknown")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return zero, errors.New("materials_unavailable")
	}
	command := environment.Command{Program: program, Args: []string{
		"desktop", "material-removal", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
		"--removal-action", action, "--material-kind", kind, "--resource-id", resourceID,
	}}
	if action == "commit" {
		var input bytes.Buffer
		if json.NewEncoder(&input).Encode(struct {
			Token string `json:"token"`
		}{token}) != nil {
			return zero, errors.New("invalid_material_removal")
		}
		command.Stdin = &input
	}
	result, err := s.rt.Run(ctx, command)
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated || len(result.Stdout) > 16384 {
		if action == "commit" && (result.Started || !result.OutcomeKnown) {
			return unknown()
		}
		return zero, errors.New("material_removal_unavailable")
	}
	var raw struct {
		Protocol int              `json:"protocol"`
		Profile  string           `json:"profile"`
		AgentID  string           `json:"agentId"`
		BootID   string           `json:"bootId"`
		Removal  *MaterialRemoval `json:"removal"`
	}
	decoder := json.NewDecoder(strings.NewReader(result.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&raw) != nil || decoder.Decode(new(any)) != io.EOF || raw.Protocol != Protocol ||
		raw.Profile != c.profile || raw.AgentID != agentID || raw.BootID != bootID || raw.Removal == nil ||
		raw.Removal.Action != action || raw.Removal.Kind != kind || raw.Removal.ResourceID != resourceID ||
		!validText(raw.Removal.Name, 1024) || strings.TrimSpace(raw.Removal.Name) == "" {
		return unknown()
	}
	if action == "prepare" {
		_, parseErr := time.Parse(time.RFC3339, raw.Removal.ExpiresAt)
		if parseErr != nil ||
			!validText(raw.Removal.Location, 8192) || !removalToken.MatchString(raw.Removal.Token) {
			return zero, errors.New("material_removal_unavailable")
		}
	} else if raw.Removal.Token != "" || raw.Removal.Location != "" || raw.Removal.ExpiresAt != "" {
		return unknown()
	}
	if c.workspaceSession(id, operation, agentID, bootID) != s || !c.materialsOnline(id, operation, agentID, bootID) {
		return unknown()
	}
	if action == "commit" {
		view, err := c.OnlineMaterialsContext(context.Background(), id, operation, agentID, bootID, "", "", "")
		if err != nil || view.Materials == nil || view.Materials.List == nil || !view.Materials.List.Complete {
			return zero, errors.New("material_removal_outcome_unknown")
		}
		for _, item := range view.Materials.List.Items {
			if item.ID == resourceID {
				return zero, errors.New("material_removal_outcome_unknown")
			}
		}
	}
	return *raw.Removal, nil
}
