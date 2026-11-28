package lifecycle

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestReconnectDoesNotGuessOrReplayUnknownOutcome(t *testing.T) {
	scope := capabilitywatch.Scope{TargetID: "local", OperationID: "operation", AgentID: "agent", BootID: "boot"}
	id, revision := "res_"+strings.Repeat("a", 64), strings.Repeat("b", 64)
	calls, mode := 0, "ok"
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		calls++
		if !strings.Contains(strings.Join(command.Args, " "), "desktop capability-reconnect") {
			t.Fatalf("wrong command %+v", command)
		}
		wire := capabilityReconnectWire{Protocol: 1, Profile: "development", AgentID: "agent", BootID: "boot", ResourceID: id, Revision: revision, Status: "succeeded"}
		if mode == "stale" {
			wire.BootID = "old"
		}
		body, _ := json.Marshal(wire)
		if mode == "unknown" {
			return environment.Result{OutcomeKnown: false}, nil
		}
		return environment.Result{OutcomeKnown: true, Stdout: string(body)}, nil
	})
	got, err := c.ReconnectCapability(scope, id, revision)
	if err != nil || got != "succeeded" || calls != 1 {
		t.Fatalf("result=%s calls=%d err=%v", got, calls, err)
	}
	mode = "unknown"
	got, err = c.ReconnectCapability(scope, id, revision)
	if err != nil || got != "unknown" || calls != 2 {
		t.Fatalf("unknown=%s calls=%d err=%v", got, calls, err)
	}
	mode = "stale"
	got, err = c.ReconnectCapability(scope, id, revision)
	if err != nil || got != "unknown" || calls != 3 {
		t.Fatalf("stale=%s calls=%d err=%v", got, calls, err)
	}
	wrong := scope
	wrong.AgentID = "other"
	if _, err := c.ReconnectCapability(wrong, id, revision); err == nil || calls != 3 {
		t.Fatal("wrong target reached action")
	}
}
