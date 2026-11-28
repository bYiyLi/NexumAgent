package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type maintenanceCommandResult struct {
	result environment.Result
	err    error
}

// resetConnection keeps a target-side helper holding the Profile lock while
// the browser approval is exchanged and the new credential is delivered.
func (c *Controller) resetConnection(ctx context.Context, s *session, a *authorization, code, agentID, bootID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	program, _, reason := programPath(ctx, s.rt, c.profile)
	if reason != "" || program == "" {
		return "", errors.New("maintenance_outcome_unknown")
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	progress := make(chan string, 1)
	done := make(chan maintenanceCommandResult, 1)
	go func() {
		result, err := s.rt.Run(ctx, environment.Command{
			Program: program,
			Args:    []string{"desktop", "maintenance-restore", "--profile", c.profile, "--server", c.origin, "--agent-id", agentID, "--boot-id", bootID},
			Stdin:   reader,
			Progress: func(stage string) {
				if stage == "stop_verify" || stage == "maintenance_busy" {
					select {
					case progress <- stage:
					default:
					}
				}
			},
		})
		done <- maintenanceCommandResult{result: result, err: err}
	}()
	select {
	case <-ctx.Done():
		return "", errors.New("maintenance_outcome_unknown")
	case stage := <-progress:
		if stage == "maintenance_busy" {
			_ = writer.Close()
			select {
			case <-ctx.Done():
				return "", errors.New("maintenance_outcome_unknown")
			case result := <-done:
				if validateMaintenanceResult(result, c.profile, agentID, bootID, "busy") {
					return "busy", nil
				}
				return "", errors.New("maintenance_outcome_unknown")
			}
		}
	case result := <-done:
		if result.err == nil && !result.result.Started {
			return "", errors.New("maintenance_unavailable")
		}
		return "", errors.New("maintenance_outcome_unknown")
	}
	c.mu.Lock()
	valid := c.validLocked(s) && ctx.Err() == nil
	c.mu.Unlock()
	if !valid {
		return "", errors.New("authorization_target_changed")
	}
	c.phase(s, "exchanging")
	cred, err := a.exchange(ctx, code)
	if err != nil || cred.AgentID != agentID {
		return "", errors.New("authorization_exchange_unknown")
	}
	c.phase(s, "restoring")
	if _, err := io.WriteString(writer, cred.Token+"\n"); err != nil {
		return "", errors.New("restore_outcome_unknown")
	}
	if err := writer.Close(); err != nil {
		return "", errors.New("restore_outcome_unknown")
	}
	select {
	case <-ctx.Done():
		return "", errors.New("restore_outcome_unknown")
	case result := <-done:
		if !validateMaintenanceResult(result, c.profile, agentID, bootID, "restored") {
			return "", errors.New("restore_outcome_unknown")
		}
		return "restored", nil
	}
}

func validateMaintenanceResult(result maintenanceCommandResult, profile, agentID, bootID, state string) bool {
	if result.err != nil || !result.result.OutcomeKnown || result.result.ExitCode != 0 || result.result.Truncated {
		return false
	}
	var output strings.Builder
	for _, line := range strings.Split(result.result.Stdout, "\n") {
		if !strings.HasPrefix(line, environment.DesktopProgressPrefix) {
			output.WriteString(line)
			output.WriteByte('\n')
		}
	}
	decoder := json.NewDecoder(strings.NewReader(output.String()))
	decoder.DisallowUnknownFields()
	var value maintenanceStopResult
	var extra any
	return decoder.Decode(&value) == nil && decoder.Decode(&extra) == io.EOF &&
		value.Protocol == Protocol && value.Profile == profile && value.AgentID == agentID &&
		value.BootID == bootID && value.State == state
}
