package lifecycle

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

// Activity is a reduced projection of the Agent's Run contract. Desktop never
// reads the Agent database, paths, or current script files itself.
type ActivityAvailability struct {
	Code   bool `json:"code"`
	Input  bool `json:"input"`
	Logs   bool `json:"logs"`
	Result bool `json:"result"`
}
type ActivityError struct {
	Message string `json:"message"`
}
type ActivityRun struct {
	RunID        string                `json:"runId"`
	Title        string                `json:"title"`
	Status       string                `json:"status"`
	Source       string                `json:"source"`
	ScriptName   *string               `json:"scriptName"`
	ProjectID    *string               `json:"projectId"`
	AcceptedAt   string                `json:"acceptedAt"`
	StartedAt    *string               `json:"startedAt"`
	FinishedAt   *string               `json:"finishedAt"`
	Error        *ActivityError        `json:"error"`
	Availability *ActivityAvailability `json:"availability"`
}
type ActivityList struct {
	Runs       []ActivityRun `json:"runs"`
	NextCursor *string       `json:"nextCursor"`
	Partial    bool          `json:"partial"`
	ObservedAt string        `json:"observedAt"`
}
type ActivityWait struct {
	Request struct {
		Message string `json:"message"`
	} `json:"request"`
	CreatedAt string `json:"createdAt"`
}
type ActivityResource struct {
	ResourceID string `json:"resourceId"`
	Kind       string `json:"kind"`
	Status     string `json:"status"`
}
type ActivityResources struct {
	Items    []ActivityResource `json:"items"`
	Complete bool               `json:"complete"`
}
type ActivityDetail struct {
	Run         ActivityRun       `json:"run"`
	Wait        *ActivityWait     `json:"wait"`
	Result      json.RawMessage   `json:"result"`
	Resources   ActivityResources `json:"resources"`
	Unavailable *struct{}         `json:"unavailable,omitempty"`
	ObservedAt  string            `json:"observedAt"`
}
type ActivityPart struct {
	Kind       string `json:"kind"`
	Offset     int64  `json:"offset"`
	NextOffset int64  `json:"nextOffset"`
	Size       int64  `json:"size"`
	Complete   bool   `json:"complete"`
	Text       string `json:"text"`
}
type ActivityResponse struct {
	List   *ActivityList   `json:"list,omitempty"`
	Detail *ActivityDetail `json:"detail,omitempty"`
	Part   *ActivityPart   `json:"part,omitempty"`
}
type ActivitySnapshot struct {
	Protocol    int              `json:"protocol"`
	Profile     string           `json:"profile"`
	TargetID    string           `json:"targetId"`
	OperationID string           `json:"operationId"`
	AgentID     string           `json:"agentId"`
	BootID      string           `json:"bootId"`
	Activity    ActivityResponse `json:"activity"`
}

func validActivityRunID(id string) bool {
	if len(id) != 36 || !strings.HasPrefix(id, "run_") || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id[4:])
	return err == nil
}
func validActivityTime(value string) bool {
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}
func validOptionalActivityTime(value *string) bool { return value == nil || validActivityTime(*value) }
func validOptionalActivityText(value *string, limit int) bool {
	return value == nil || validText(*value, limit)
}
func validActivityRun(run ActivityRun) bool {
	return validActivityRunID(run.RunID) && len(run.Title) <= 1024 && utf8.ValidString(run.Title) && !strings.ContainsRune(run.Title, 0) &&
		oneOf(run.Status, "accepted", "preparing_inputs", "running", "waiting_input", "cancelling", "succeeded", "failed", "cancelled", "interrupted") &&
		oneOf(run.Source, "inline", "named", "history") && validOptionalActivityText(run.ScriptName, 1024) && validOptionalActivityText(run.ProjectID, 256) &&
		validActivityTime(run.AcceptedAt) && validOptionalActivityTime(run.StartedAt) && validOptionalActivityTime(run.FinishedAt) && run.Availability != nil &&
		(run.Error == nil || (len(run.Error.Message) <= 8192 && utf8.ValidString(run.Error.Message) && !strings.ContainsRune(run.Error.Message, 0)))
}
func validActivityCursor(cursor string) bool {
	if len(cursor) > 512 {
		return false
	}
	if cursor == "" {
		return true
	}
	_, err := base64.RawURLEncoding.DecodeString(cursor)
	return err == nil
}
func validActivityResponse(v ActivityResponse, action, runID, kind string, offset int64) bool {
	switch action {
	case "list":
		if v.List == nil || v.Detail != nil || v.Part != nil || v.List.Runs == nil || len(v.List.Runs) > 25 || !validActivityTime(v.List.ObservedAt) ||
			(v.List.NextCursor != nil && (*v.List.NextCursor == "" || !validActivityCursor(*v.List.NextCursor))) {
			return false
		}
		seen := make(map[string]bool, len(v.List.Runs))
		for _, run := range v.List.Runs {
			if !validActivityRun(run) || seen[run.RunID] {
				return false
			}
			seen[run.RunID] = true
		}
		return true
	case "detail":
		d := v.Detail
		if d == nil || v.List != nil || v.Part != nil || !validActivityRun(d.Run) || d.Run.RunID != runID || !validActivityTime(d.ObservedAt) ||
			d.Resources.Items == nil || len(d.Resources.Items) > 64 || (d.Wait != nil && (!validActivityTime(d.Wait.CreatedAt) || len(d.Wait.Request.Message) > 8192)) ||
			len(d.Result) > 128*1024 || (len(d.Result) > 0 && !json.Valid(d.Result)) {
			return false
		}
		for _, item := range d.Resources.Items {
			if !validText(item.ResourceID, 256) || !validText(item.Kind, 256) || !validText(item.Status, 256) {
				return false
			}
		}
		return true
	case "part":
		p := v.Part
		return p != nil && v.List == nil && v.Detail == nil && p.Kind == kind && p.Offset >= offset && p.NextOffset >= p.Offset && p.Size >= p.NextOffset &&
			p.Complete == (p.NextOffset >= p.Size) && len(p.Text) <= 16384 && utf8.ValidString(p.Text) && (p.Text != "" || p.Complete)
	}
	return false
}

func (c *Controller) Activity(id, operation, agentID, bootID, action, runID, cursor, kind string, offset int64) (ActivitySnapshot, error) {
	valid := (action == "list" && runID == "" && kind == "" && offset == 0 && validActivityCursor(cursor)) ||
		(action == "detail" && validActivityRunID(runID) && cursor == "" && kind == "" && offset == 0) ||
		(action == "part" && validActivityRunID(runID) && cursor == "" && oneOf(kind, "code", "input", "logs") && offset >= 0 && offset <= 9007199254740991)
	if !valid {
		return ActivitySnapshot{}, errors.New("invalid_activity_request")
	}
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == id && s.operation == operation && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == agentID && s.state.Summary.BootID == bootID
	c.mu.Unlock()
	if !admitted {
		return ActivitySnapshot{}, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return ActivitySnapshot{}, errors.New("activity_unavailable")
	}
	args := []string{"desktop", "activity", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID, "--activity-action", action}
	if runID != "" {
		args = append(args, "--run-id", runID)
	}
	if cursor != "" {
		args = append(args, "--cursor", cursor)
	}
	if kind != "" {
		args = append(args, "--part", kind, "--offset", strconv.FormatInt(offset, 10), "--max-bytes", "16384")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: args})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 512*1024 {
		return ActivitySnapshot{}, errors.New("activity_unavailable")
	}
	var raw struct {
		Protocol int             `json:"protocol"`
		Profile  string          `json:"profile"`
		AgentID  string          `json:"agentId"`
		BootID   string          `json:"bootId"`
		Activity json.RawMessage `json:"activity"`
	}
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&raw) != nil || decoder.Decode(new(any)) != io.EOF || raw.Protocol != Protocol || raw.Profile != c.profile || raw.AgentID != agentID || raw.BootID != bootID {
		return ActivitySnapshot{}, errors.New("activity_unavailable")
	}
	var response ActivityResponse
	if json.Unmarshal(raw.Activity, &response) != nil || !validActivityResponse(response, action, runID, kind, offset) {
		return ActivitySnapshot{}, errors.New("activity_unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != agentID || s.state.Summary.BootID != bootID {
		return ActivitySnapshot{}, errors.New("environment_changed")
	}
	return ActivitySnapshot{Protocol: Protocol, Profile: c.profile, TargetID: id, OperationID: operation, AgentID: agentID, BootID: bootID, Activity: response}, nil
}
