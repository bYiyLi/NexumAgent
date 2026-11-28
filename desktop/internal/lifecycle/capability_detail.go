package lifecycle

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type CapabilityParameter struct {
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`
	Location string `json:"location,omitempty"`
	Required bool   `json:"required"`
}
type CapabilityMethod struct {
	Name        string                `json:"name"`
	Description string                `json:"description,omitempty"`
	Method      string                `json:"method,omitempty"`
	Path        string                `json:"path,omitempty"`
	Parameters  []CapabilityParameter `json:"parameters"`
}
type CapabilityDetail struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Type            string             `json:"type"`
	Configuration   json.RawMessage    `json:"configuration"`
	Methods         []CapabilityMethod `json:"methods"`
	MethodsComplete bool               `json:"methodsComplete"`
}
type CapabilityDetailSnapshot struct {
	Protocol    int              `json:"protocol"`
	Profile     string           `json:"profile"`
	TargetID    string           `json:"targetId"`
	OperationID string           `json:"operationId"`
	AgentID     string           `json:"agentId"`
	BootID      string           `json:"bootId"`
	Detail      CapabilityDetail `json:"detail"`
}

func validCapabilityResourceID(id string) bool {
	if len(id) != 68 || !strings.HasPrefix(id, "res_") || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id[4:])
	return err == nil
}

func validCapabilityDetail(v CapabilityDetailSnapshot, profile, agentID, bootID, resourceID string) bool {
	d := v.Detail
	if v.Protocol != Protocol || v.Profile != profile || v.AgentID != agentID || v.BootID != bootID ||
		v.TargetID != "" || v.OperationID != "" || !validCapabilityResourceID(resourceID) || d.ID != resourceID ||
		!validText(d.Name, 256) || !oneOf(d.Type, "mcp", "openapi", "npm") || d.Methods == nil || len(d.Methods) > 64 ||
		len(d.Configuration) == 0 || len(d.Configuration) > 16*1024 {
		return false
	}
	var config map[string]any
	if json.Unmarshal(d.Configuration, &config) != nil || config == nil {
		return false
	}
	for _, method := range d.Methods {
		if !validText(method.Name, 256) || len(method.Description) > 2048 || !utf8.ValidString(method.Description) || strings.ContainsRune(method.Description, 0) ||
			len(method.Method) > 16 || len(method.Path) > 2048 || strings.ContainsAny(method.Method+method.Path, "\x00\r\n") ||
			method.Parameters == nil || len(method.Parameters) > 32 {
			return false
		}
		for _, parameter := range method.Parameters {
			if !validText(parameter.Name, 256) || len(parameter.Type) > 128 || strings.ContainsAny(parameter.Type, "\x00\r\n") ||
				(parameter.Location != "" && !oneOf(parameter.Location, "path", "query", "header", "cookie", "body")) {
				return false
			}
		}
	}
	return true
}

// Resolve the requested resource only through the current verified Agent.
func (c *Controller) CapabilityDetail(id, operation, agentID, bootID, resourceID string) (CapabilityDetailSnapshot, error) {
	return c.CapabilityDetailContext(context.Background(), id, operation, agentID, bootID, resourceID)
}

func (c *Controller) CapabilityDetailContext(parent context.Context, id, operation, agentID, bootID, resourceID string) (CapabilityDetailSnapshot, error) {
	if err := parent.Err(); err != nil {
		return CapabilityDetailSnapshot{}, err
	}
	if !validCapabilityResourceID(resourceID) {
		return CapabilityDetailSnapshot{}, errors.New("capability_detail_unavailable")
	}
	c.mu.Lock()
	s := c.current
	admitted := s != nil && s.id == id && s.operation == operation && c.validLocked(s) && s.state.Stage == "ready" &&
		s.state.Summary != nil && s.state.Summary.AgentID == agentID && s.state.Summary.BootID == bootID
	c.mu.Unlock()
	if !admitted {
		return CapabilityDetailSnapshot{}, errors.New("lifecycle_check_required")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	stop := context.AfterFunc(parent, cancel)
	defer func() { stop(); cancel() }()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return CapabilityDetailSnapshot{}, errors.New("capability_detail_unavailable")
	}
	res, err := s.rt.Run(ctx, environment.Command{Program: program, Args: []string{
		"desktop", "capability-detail", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID, "--resource-id", resourceID,
	}})
	if err != nil || !res.OutcomeKnown || res.ExitCode != 0 || res.Truncated || len(res.Stdout) > 512*1024 {
		return CapabilityDetailSnapshot{}, errors.New("capability_detail_unavailable")
	}
	var result CapabilityDetailSnapshot
	decoder := json.NewDecoder(strings.NewReader(res.Stdout))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || !validCapabilityDetail(result, c.profile, agentID, bootID, resourceID) {
		return CapabilityDetailSnapshot{}, errors.New("capability_detail_unavailable")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return CapabilityDetailSnapshot{}, errors.New("capability_detail_unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if parent.Err() != nil || !c.validLocked(s) || s.state.Stage != "ready" || s.state.Summary == nil || s.state.Summary.AgentID != agentID || s.state.Summary.BootID != bootID {
		return CapabilityDetailSnapshot{}, errors.New("environment_changed")
	}
	result.TargetID, result.OperationID = id, operation
	return result, nil
}
