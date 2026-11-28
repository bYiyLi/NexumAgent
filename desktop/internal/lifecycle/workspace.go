package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type MaterialItem struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source,omitempty"`
	Revision    string `json:"revision,omitempty"`
	Problem     string `json:"problem,omitempty"`
	CanRemove   bool   `json:"canRemove,omitempty"`
}

type MaterialList struct {
	Items    []MaterialItem `json:"items"`
	Complete bool           `json:"complete"`
}

type MaterialDetail struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	Content        string          `json:"content"`
	Complete       bool            `json:"complete"`
	Member         string          `json:"member,omitempty"`
	Members        []string        `json:"members,omitempty"`
	TreeIncomplete bool            `json:"treeIncomplete,omitempty"`
	When           string          `json:"when,omitempty"`
	InputSchema    json.RawMessage `json:"inputSchema,omitempty"`
	OutputSchema   json.RawMessage `json:"outputSchema,omitempty"`
}

type MaterialsView struct {
	List   *MaterialList   `json:"list,omitempty"`
	Detail *MaterialDetail `json:"detail,omitempty"`
}

type WorkspaceTelemetry struct {
	Scope       string   `json:"scope"`
	ObservedAt  string   `json:"observedAt"`
	CPUPercent  *float64 `json:"cpuPercent,omitempty"`
	MemoryRSSMB *float64 `json:"memoryRssMb,omitempty"`
}

type WorkspaceSnapshot struct {
	Protocol     int                 `json:"protocol"`
	Profile      string              `json:"profile"`
	TargetID     string              `json:"targetId"`
	OperationID  string              `json:"operationId"`
	AgentID      string              `json:"agentId"`
	BootID       string              `json:"bootId"`
	Materials    *MaterialsView      `json:"materials,omitempty"`
	Telemetry    *WorkspaceTelemetry `json:"telemetry,omitempty"`
	SystemEvents *SystemEvents       `json:"systemEvents,omitempty"`
}

func (c *Controller) workspaceSession(id, operation, agentID, bootID string) *session {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || !c.validLocked(s) || s.state.Stage != "ready" ||
		s.state.Summary == nil || s.state.Summary.AgentID != agentID || s.state.Summary.BootID != bootID {
		return nil
	}
	return s
}

var cloudAgentID = regexp.MustCompile(`^agt_[A-Za-z0-9_-]{1,128}$`)

// The browser receives a fixed Cloud route and uses its own authenticated session.
func (c *Controller) CloudAgentURL(id, operation, agentID, bootID string) (string, error) {
	if !cloudAgentID.MatchString(agentID) || c.workspaceSession(id, operation, agentID, bootID) == nil {
		return "", errors.New("lifecycle_check_required")
	}
	return c.origin + "/agents/" + agentID, nil
}

func validWorkspaceMember(member string) bool {
	if !validText(member, 1024) || strings.ContainsAny(member, "\\:") {
		return false
	}
	parts := strings.Split(member, "/")
	if len(parts) > 7 {
		return false
	}
	for _, part := range parts {
		if part == "" || strings.HasPrefix(part, ".") || part == "node_modules" {
			return false
		}
	}
	return true
}

func materialViewValid(value *MaterialsView, kind, resourceID, member string) bool {
	if value == nil {
		return false
	}
	if kind == "" {
		if value.List == nil || value.Detail != nil || value.List.Items == nil || len(value.List.Items) > 200 {
			return false
		}
		seen := make(map[string]bool, len(value.List.Items))
		for _, item := range value.List.Items {
			if !validCapabilityResourceID(item.ID) || seen[item.ID] || !validText(item.Name, 1024) || strings.TrimSpace(item.Name) == "" ||
				len(item.Description) > 640 || strings.ContainsRune(item.Description, 0) || !oneOf(item.Kind, "instruction", "skill", "script") ||
				len(item.Revision) > 256 || strings.ContainsRune(item.Revision, 0) ||
				!oneOf(item.Source, "", "personal", "local", "platform", "extension") ||
				!oneOf(item.Problem, "", "invalid_skill", "invalid_script_header", "script_header_mismatch", "invalid_input_schema", "invalid_output_schema", "script_name_conflict") ||
				(item.CanRemove && !(item.Kind == "skill" && item.Source == "personal" || item.Kind == "script" && item.Source == "local")) {
				return false
			}
			seen[item.ID] = true
		}
		return true
	}
	d := value.Detail
	if value.List != nil || d == nil || d.ID != resourceID || d.Kind != kind || len(d.Content) > 48*1024 || strings.ContainsRune(d.Content, 0) ||
		len(d.When) > 8192 || strings.ContainsRune(d.When, 0) || len(d.InputSchema) > 16*1024 || len(d.OutputSchema) > 16*1024 {
		return false
	}
	if kind != "skill" {
		return d.Member == "" && len(d.Members) == 0 && !d.TreeIncomplete && (kind == "script" || d.When == "" && len(d.InputSchema)+len(d.OutputSchema) == 0)
	}
	if d.When != "" || len(d.InputSchema)+len(d.OutputSchema) != 0 || len(d.Members) > 64 {
		return false
	}
	if member != "" {
		return d.Member == member && len(d.Members) == 0 && !d.TreeIncomplete
	}
	if d.Member != "SKILL.md" || len(d.Members) == 0 || d.Members[0] != "SKILL.md" {
		return false
	}
	seen := map[string]bool{}
	for _, p := range d.Members {
		if !validWorkspaceMember(p) || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}

func telemetryValid(t *WorkspaceTelemetry) bool {
	if t == nil || t.Scope != "node_host" {
		return false
	}
	if _, err := time.Parse(time.RFC3339, t.ObservedAt); err != nil {
		return false
	}
	return (t.CPUPercent == nil || *t.CPUPercent >= 0 && *t.CPUPercent <= 100) &&
		(t.MemoryRSSMB == nil || *t.MemoryRSSMB > 0 && !math.IsInf(*t.MemoryRSSMB, 0))
}

func (c *Controller) Materials(id, operation, agentID, bootID, kind, resourceID, member string) (WorkspaceSnapshot, error) {
	return c.MaterialsContext(context.Background(), id, operation, agentID, bootID, kind, resourceID, member)
}

func (c *Controller) MaterialsContext(parent context.Context, id, operation, agentID, bootID, kind, resourceID, member string) (WorkspaceSnapshot, error) {
	if kind == "" && (resourceID != "" || member != "") ||
		kind != "" && (!oneOf(kind, "skill", "script", "instruction") || !validCapabilityResourceID(resourceID) ||
			member != "" && (kind != "skill" || !validWorkspaceMember(member))) {
		return WorkspaceSnapshot{}, errors.New("invalid_materials_request")
	}
	if !c.MaterialsAvailable(id, operation, agentID, bootID) {
		return WorkspaceSnapshot{}, errors.New("materials_unavailable")
	}
	result, err := c.readWorkspace(parent, id, operation, agentID, bootID, "materials", kind, resourceID, member)
	if err != nil || !c.MaterialsAvailable(id, operation, agentID, bootID) {
		return WorkspaceSnapshot{}, errors.New("materials_unavailable")
	}
	return result, nil
}

func (c *Controller) materialsOnline(id, operation, agentID, bootID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	return s != nil && s.id == id && s.operation == operation && c.validLocked(s) &&
		s.state.Stage == "ready" && s.state.Summary != nil && s.state.Summary.Cloud == "online" &&
		s.state.Summary.AgentID == agentID && s.state.Summary.BootID == bootID
}

func (c *Controller) MaterialsAvailable(id, operation, agentID, bootID string) bool {
	return c.workspaceSession(id, operation, agentID, bootID) != nil
}

func (c *Controller) Telemetry(id, operation, agentID, bootID string) (WorkspaceSnapshot, error) {
	return c.readWorkspace(context.Background(), id, operation, agentID, bootID, "telemetry", "", "", "")
}

func (c *Controller) readWorkspace(parent context.Context, id, operation, agentID, bootID, view, kind, resourceID, member string) (WorkspaceSnapshot, error) {
	var zero WorkspaceSnapshot
	s := c.workspaceSession(id, operation, agentID, bootID)
	if s == nil {
		return zero, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	stop := context.AfterFunc(parent, cancel)
	defer stop()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return zero, errors.New("workspace_unavailable")
	}
	args := []string{"desktop", view, "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID}
	if kind != "" {
		args = append(args, "--material-kind", kind, "--resource-id", resourceID)
	}
	if member != "" {
		args = append(args, "--member", member)
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: args})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 512*1024 {
		return zero, errors.New("workspace_unavailable")
	}
	var result WorkspaceSnapshot
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&result) != nil || decoder.Decode(&extra) != io.EOF || result.Protocol != Protocol || result.Profile != c.profile ||
		result.AgentID != agentID || result.BootID != bootID || result.TargetID != "" || result.OperationID != "" {
		return zero, errors.New("workspace_unavailable")
	}
	if view == "materials" && (result.Telemetry != nil || result.SystemEvents != nil || !materialViewValid(result.Materials, kind, resourceID, member)) ||
		view == "telemetry" && (result.Materials != nil || result.SystemEvents != nil || !telemetryValid(result.Telemetry)) ||
		view == "system-events" && (result.Materials != nil || result.Telemetry != nil || !systemEventsValid(result.SystemEvents)) {
		return zero, errors.New("workspace_unavailable")
	}
	if c.workspaceSession(id, operation, agentID, bootID) != s {
		return zero, errors.New("environment_changed")
	}
	result.TargetID, result.OperationID = id, operation
	return result, nil
}
