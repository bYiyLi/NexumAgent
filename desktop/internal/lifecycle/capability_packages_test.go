package lifecycle

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestCapabilityPackagesRequiresMatchingGeneration(t *testing.T) {
	scope := capabilitywatch.Scope{TargetID: "local", OperationID: "operation", AgentID: "agent", BootID: "boot"}
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if !strings.Contains(strings.Join(command.Args, " "), "desktop capability-packages") {
			t.Fatal("wrong command")
		}
		body, _ := json.Marshal(capabilityPackagesWire{Protocol: 1, Profile: "development", AgentID: "agent", BootID: "boot", Revision: "3", State: "available", Items: []capabilitywatch.Fact{{ID: "res_" + strings.Repeat("a", 64), Name: "missing", Type: "npm", Revision: strings.Repeat("b", 64), State: "missing", Reason: "package_missing"}}})
		return environment.Result{OutcomeKnown: true, Stdout: string(body)}, nil
	})
	facts, state, err := c.CapabilityPackages(context.Background(), scope, "3")
	if err != nil || state != "available" || len(facts) != 1 || facts[0].State != "missing" {
		t.Fatalf("facts=%+v %s %v", facts, state, err)
	}
	if _, _, err := c.CapabilityPackages(context.Background(), scope, "4"); err == nil {
		t.Fatal("stale generation accepted")
	}
}
