package lifecycle

import (
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestMaterialRemovalRequiresOnlineAndReportsUnknownWithoutRetry(t *testing.T) {
	const agentID, bootID = "agent", "boot"
	id := "res_" + strings.Repeat("a", 64)
	token := strings.Repeat("b", 64)
	calls, reads := 0, 0
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] == "materials" {
			reads++
			value := WorkspaceSnapshot{Protocol: Protocol, Profile: "development", AgentID: agentID, BootID: bootID,
				Materials: &MaterialsView{List: &MaterialList{Complete: true, Items: []MaterialItem{{ID: id, Kind: "script", Name: "fixture.js", Source: "local", CanRemove: true}}}}}
			data, _ := json.Marshal(value)
			return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
		}
		calls++
		if strings.Contains(strings.Join(command.Args, " "), token) {
			t.Fatal("confirmation token was placed in process arguments")
		}
		if calls == 1 {
			value := struct {
				Protocol int              `json:"protocol"`
				Profile  string           `json:"profile"`
				AgentID  string           `json:"agentId"`
				BootID   string           `json:"bootId"`
				Removal  *MaterialRemoval `json:"removal"`
			}{Protocol, "development", agentID, bootID, &MaterialRemoval{
				Action: "prepare", Kind: "script", ResourceID: id, Name: "fixture.js", Location: "/tmp/fixture.js",
				Token: token, ExpiresAt: "2099-01-01T00:00:00Z",
			}}
			data, _ := json.Marshal(value)
			return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
		}
		if command.Stdin == nil {
			t.Fatal("confirmation token was not sent through stdin")
		}
		data, _ := io.ReadAll(command.Stdin)
		if !strings.Contains(string(data), token) {
			t.Fatal("confirmation token missing from stdin")
		}
		return environment.Result{Started: true, OutcomeKnown: false}, nil
	})
	c.current.state.Summary.Cloud = "online"
	prepared, err := c.RemoveMaterial("local", "operation", agentID, bootID, "prepare", "script", id, "")
	if err != nil || prepared.Token != token || prepared.Location != "/tmp/fixture.js" || reads != 1 {
		t.Fatalf("prepare: %+v (%v)", prepared, err)
	}
	c.current.state.Summary.Cloud = "offline"
	if _, err := c.RemoveMaterial("local", "operation", agentID, bootID, "commit", "script", id, token); err == nil || calls != 1 {
		t.Fatal("offline confirmation reached the Agent")
	}
	c.current.state.Summary.Cloud = "online"
	if _, err := c.RemoveMaterial("local", "operation", agentID, bootID, "commit", "script", id, token); err == nil || err.Error() != "material_removal_outcome_unknown" || calls != 2 || reads != 2 {
		t.Fatalf("lost result was not read back and reported as unknown: %v, calls=%d reads=%d", err, calls, reads)
	}
}

func TestMaterialRemovalSuccessRequiresCompleteReadback(t *testing.T) {
	id := "res_" + strings.Repeat("a", 64)
	token := strings.Repeat("b", 64)
	for _, complete := range []bool{true, false} {
		t.Run(map[bool]string{true: "complete", false: "partial"}[complete], func(t *testing.T) {
			reads := 0
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if command.Args[1] == "materials" {
					reads++
					value := WorkspaceSnapshot{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot",
						Materials: &MaterialsView{List: &MaterialList{Items: []MaterialItem{}, Complete: complete}}}
					data, _ := json.Marshal(value)
					return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
				}
				value := struct {
					Protocol int              `json:"protocol"`
					Profile  string           `json:"profile"`
					AgentID  string           `json:"agentId"`
					BootID   string           `json:"bootId"`
					Removal  *MaterialRemoval `json:"removal"`
				}{Protocol, "development", "agent", "boot", &MaterialRemoval{Action: "commit", Kind: "script", ResourceID: id, Name: "fixture.js"}}
				data, _ := json.Marshal(value)
				return environment.Result{OutcomeKnown: true, Started: true, Stdout: string(data)}, nil
			})
			c.current.state.Summary.Cloud = "online"
			_, err := c.RemoveMaterial("local", "operation", "agent", "boot", "commit", "script", id, token)
			if reads != 1 || (err == nil) != complete {
				t.Fatalf("complete=%v readback=%d error=%v", complete, reads, err)
			}
		})
	}
}
