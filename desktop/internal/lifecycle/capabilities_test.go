package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type capabilityRuntime struct {
	fixtureRuntime
	read func(environment.Command) (environment.Result, error)
}

func (r *capabilityRuntime) Run(_ context.Context, command environment.Command) (environment.Result, error) {
	return r.read(command)
}

func capabilityController(t *testing.T, read func(environment.Command) (environment.Result, error)) *Controller {
	t.Helper()
	rt := &capabilityRuntime{read: read}
	c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", "https://example.test")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c.current = &session{id: "local", operation: "operation", rt: rt, ctx: ctx, cancel: cancel,
		state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: "agent", BootID: "boot"}}}
	return c
}

func capabilityOutput() CapabilityInventory {
	return CapabilityInventory{Protocol: 1, Profile: "development", AgentID: "agent", BootID: "boot", State: "available",
		Items: []Capability{{ID: "m", Name: "GitHub", Type: "mcp"}, {ID: "a", Name: "CRM", Type: "openapi"}, {ID: "n", Name: "@fixture/installed", Type: "npm"}}}
}

func TestCapabilitiesUsesVerifiedTargetCLI(t *testing.T) {
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if strings.Join(command.Args, " ") != "desktop capabilities --profile development --server https://example.test --agent-id agent --boot-id boot" ||
			command.Program != "/test-home/.nexum-dev/bin/nexum-agent" || command.Stdin != nil {
			t.Fatal("unexpected capability command", command)
		}
		data, _ := json.Marshal(capabilityOutput())
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	got, err := c.Capabilities("local", "operation", "agent", "boot")
	if err != nil || got.TargetID != "local" || got.OperationID != "operation" || len(got.Items) != 3 || got.State != "available" {
		t.Fatalf("inventory=%+v err=%v", got, err)
	}
	for _, args := range [][4]string{{"other", "operation", "agent", "boot"}, {"local", "old-operation", "agent", "boot"}, {"local", "operation", "other", "boot"}, {"local", "operation", "agent", "old-boot"}} {
		if _, err := c.Capabilities(args[0], args[1], args[2], args[3]); err == nil {
			t.Fatal("stale request admitted", args)
		}
	}
}

func TestCapabilitiesRejectMalformedUnknownAndStaleResults(t *testing.T) {
	for _, scenario := range []string{"wrong-profile", "wrong-agent", "wrong-boot", "wrong-kind", "duplicate", "secret-field", "extra-json", "truncated", "permission", "old-agent", "target-left", "empty", "partial-empty"} {
		t.Run(scenario, func(t *testing.T) {
			var c *Controller
			c = capabilityController(t, func(environment.Command) (environment.Result, error) {
				v := capabilityOutput()
				switch scenario {
				case "wrong-profile":
					v.Profile = "production"
				case "wrong-agent":
					v.AgentID = "other"
				case "wrong-boot":
					v.BootID = "other"
				case "wrong-kind":
					v.Items[0].Type = "skill"
				case "duplicate":
					v.Items = append(v.Items, v.Items[0])
				case "empty", "partial-empty":
					v.Items = []Capability{}
				}
				if scenario == "partial-empty" {
					v.State = "partial"
				}
				data, _ := json.Marshal(v)
				out := environment.Result{OutcomeKnown: true, Stdout: string(data)}
				switch scenario {
				case "secret-field":
					out.Stdout = strings.TrimSuffix(out.Stdout, "}") + `,"token":"must-not-reach-webview"}`
				case "extra-json":
					out.Stdout += `{}`
				case "truncated":
					out.Truncated = true
				case "permission":
					return out, errors.New("permission denied: private-path")
				case "old-agent":
					out.ExitCode = 2
				case "target-left":
					c.Leave("local", "operation")
				}
				return out, nil
			})
			got, err := c.Capabilities("local", "operation", "agent", "boot")
			if scenario == "empty" || scenario == "partial-empty" {
				if err != nil || got.Items == nil || len(got.Items) != 0 || (got.State == "partial") != (scenario == "partial-empty") {
					t.Fatal("empty inventory state lost", got, err)
				}
			} else if err == nil || len(got.Items) > 0 || strings.Contains(err.Error(), "private-path") {
				t.Fatal("unverified result escaped", got, err)
			}
		})
	}
}
