package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type SkillEvidence struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Repo      string `json:"repo"`
	Ref       string `json:"ref,omitempty"`
	Path      string `json:"path"`
	Installed string `json:"installed"`
	Problem   string `json:"problem,omitempty"`
}

var evidenceRepository = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
var evidenceRevision = regexp.MustCompile(`^[a-f0-9]{40}$`)

func validEvidenceRepository(s string) bool {
	if !evidenceRepository.MatchString(s) {
		return false
	}
	parts := strings.Split(s, "/")
	return parts[0] != "." && parts[0] != ".." && parts[1] != "." && parts[1] != ".."
}

func validEvidencePath(s string) bool {
	if s == "" || len(s) > 512 || strings.ContainsAny(s, "\\:\x00\r\n") || strings.HasPrefix(s, "/") {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func (c *Controller) SkillEvidence(ctxParent context.Context, id, operation, agentID, bootID string, missingOnly bool) ([]SkillEvidence, error) {
	s := c.workspaceSession(id, operation, agentID, bootID)
	if s == nil || !c.MaterialsOnline(id, operation, agentID, bootID) {
		return nil, errors.New("materials_unavailable")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctxParent, cancel)
	defer stop()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return nil, errors.New("materials_unavailable")
	}
	args := []string{
		"desktop", "material-evidence", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID,
	}
	if missingOnly {
		args = append(args, "--evidence-mode", "missing")
	}
	result, err := s.rt.Run(ctx, environment.Command{Program: program, Args: args})
	if err != nil || !result.OutcomeKnown || result.ExitCode != 0 || result.Truncated || len(result.Stdout) > 512*1024 {
		return nil, errors.New("materials_unavailable")
	}
	var raw struct {
		Protocol int             `json:"protocol"`
		Profile  string          `json:"profile"`
		AgentID  string          `json:"agentId"`
		BootID   string          `json:"bootId"`
		Items    []SkillEvidence `json:"items"`
	}
	decoder := json.NewDecoder(strings.NewReader(result.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&raw) != nil || decoder.Decode(new(any)) != io.EOF || raw.Protocol != Protocol ||
		raw.Profile != c.profile || raw.AgentID != agentID || raw.BootID != bootID || raw.Items == nil || len(raw.Items) > 2000 {
		return nil, errors.New("materials_unavailable")
	}
	seen := make(map[string]bool, len(raw.Items))
	for _, item := range raw.Items {
		if !validCapabilityResourceID(item.ID) || seen[item.ID] || !validText(item.Name, 100) || strings.TrimSpace(item.Name) == "" ||
			(item.Problem != "" && item.Problem != "missing_skill_entry") || missingOnly && item.Problem != "missing_skill_entry" ||
			!validEvidenceRepository(item.Repo) ||
			!validEvidencePath(item.Path) || item.Ref != "" && !validEvidencePath(item.Ref) || !evidenceRevision.MatchString(item.Installed) {
			return nil, errors.New("materials_unavailable")
		}
		seen[item.ID] = true
	}
	if c.workspaceSession(id, operation, agentID, bootID) != s || !c.MaterialsOnline(id, operation, agentID, bootID) {
		return nil, errors.New("environment_changed")
	}
	return raw.Items, nil
}
