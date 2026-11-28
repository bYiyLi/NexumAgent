package lifecycle

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestCapabilityDetailBindsResourceAndCurrentSession(t *testing.T) {
	id := "res_" + strings.Repeat("a", 64)
	for _, scenario := range []string{"valid", "wrong-resource", "wrong-boot", "unknown-field", "target-left", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			var c *Controller
			c = capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if strings.Join(command.Args, " ") != "desktop capability-detail --profile development --server https://example.test --agent-id agent --boot-id boot --resource-id "+id || command.Stdin != nil {
					t.Fatal("unexpected command", command)
				}
				v := CapabilityDetailSnapshot{Protocol: 1, Profile: "development", AgentID: "agent", BootID: "boot", Detail: CapabilityDetail{
					ID: id, Name: "GitHub", Type: "mcp", Configuration: json.RawMessage(`{"type":"http"}`), Methods: []CapabilityMethod{}, MethodsComplete: true,
				}}
				if scenario == "wrong-resource" {
					v.Detail.ID = "res_" + strings.Repeat("b", 64)
				}
				if scenario == "wrong-boot" {
					v.BootID = "old-boot"
				}
				body, _ := json.Marshal(v)
				out := environment.Result{OutcomeKnown: true, Stdout: string(body)}
				if scenario == "unknown-field" {
					out.Stdout = strings.TrimSuffix(out.Stdout, "}") + `,"token":"must-not-pass"}`
				}
				if scenario == "target-left" {
					c.Leave("local", "operation")
				}
				if scenario == "truncated" {
					out.Truncated = true
				}
				return out, nil
			})
			got, err := c.CapabilityDetail("local", "operation", "agent", "boot", id)
			if scenario == "valid" {
				if err != nil || got.TargetID != "local" || got.Detail.ID != id {
					t.Fatal("valid detail rejected", got, err)
				}
			} else if err == nil || got.Detail.ID != "" {
				t.Fatal("unverified detail admitted", got, err)
			}
		})
	}
}
