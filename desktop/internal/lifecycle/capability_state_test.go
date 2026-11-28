package lifecycle

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestCapabilityStateUsesOnlyCurrentTargetAndRejectsOldNative(t *testing.T) {
	scope := capabilitywatch.Scope{TargetID: "local", OperationID: "operation", AgentID: "agent", BootID: "boot"}
	old := false
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if strings.Join(command.Args, " ") != "desktop capability-state --profile development --server https://example.test --agent-id agent --boot-id boot" {
			t.Fatalf("unexpected command %+v", command)
		}
		if old {
			return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
		}
		body, _ := json.Marshal(capabilityStateWire{Protocol: 1, Profile: "development", AgentID: "agent", BootID: "boot", State: "partial", Items: []capabilitywatch.Fact{
			{ID: "res_" + strings.Repeat("a", 64), Name: "github", Type: "mcp", Revision: strings.Repeat("b", 64), State: "disconnected", Reason: "mcp_disconnected"},
		}})
		return environment.Result{OutcomeKnown: true, Stdout: string(body)}, nil
	})
	got, err := c.CapabilityState(context.Background(), scope)
	if err != nil || got.Scope != scope || len(got.Facts) != 1 {
		t.Fatalf("facts=%+v err=%v", got, err)
	}
	wrong := scope
	wrong.BootID = "old"
	if _, err := c.CapabilityState(context.Background(), wrong); err == nil {
		t.Fatal("old boot admitted")
	}
	old = true
	if _, err := c.CapabilityState(context.Background(), scope); err == nil {
		t.Fatal("unsupported native guessed state")
	}
}
