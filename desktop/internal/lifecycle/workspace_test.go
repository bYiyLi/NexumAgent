package lifecycle

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestWorkspaceReadsAndConsoleLinkRequireCurrentBoot(t *testing.T) {
	resource := "res_" + strings.Repeat("a", 64)
	const id, boot = "agt_fixture", "boot-current"
	var c *Controller
	calls := 0
	c = capabilityController(t, func(command environment.Command) (environment.Result, error) {
		calls++
		want := "desktop materials --profile development --server https://example.test --agent-id agt_fixture --boot-id boot-current --material-kind skill --resource-id " + resource + " --member references/guide.md"
		if strings.Join(command.Args, " ") != want || command.Stdin != nil {
			t.Fatalf("unexpected workspace command %v", command.Args)
		}
		view := WorkspaceSnapshot{Protocol: Protocol, Profile: "development", AgentID: id, BootID: boot,
			Materials: &MaterialsView{Detail: &MaterialDetail{ID: resource, Kind: "skill", Member: "references/guide.md", Complete: true, Content: "Guide"}}}
		if calls == 3 {
			c.Leave("local", "operation")
		}
		body, _ := json.Marshal(view)
		return environment.Result{OutcomeKnown: true, Stdout: string(body)}, nil
	})
	c.current.state.Summary = &Summary{AgentID: id, BootID: boot, Cloud: "online"}
	if url, err := c.CloudAgentURL("local", "operation", id, boot); err != nil || url != "https://example.test/agents/agt_fixture" {
		t.Fatalf("Agent URL = %q (%v)", url, err)
	}
	if _, err := c.CloudAgentURL("local", "operation", id, "other-boot"); err == nil {
		t.Fatal("a stale boot opened the Cloud console")
	}
	if _, err := c.Materials("local", "operation", id, boot, "skill", resource, "../config.json"); err == nil || calls != 0 {
		t.Fatal("a path outside the Skill reached Native")
	}
	got, err := c.Materials("local", "operation", id, boot, "skill", resource, "references/guide.md")
	if err != nil || got.TargetID != "local" || got.OperationID != "operation" || got.Materials.Detail.Content != "Guide" {
		t.Fatalf("detail: %+v (%v)", got, err)
	}
	c.current.state.Summary.Cloud = "offline"
	if _, err := c.Materials("local", "operation", id, boot, "skill", resource, "references/guide.md"); err != nil || calls != 2 {
		t.Fatalf("offline detail unavailable: %v", err)
	}
	c.current.state.Summary.Cloud = "online"
	if _, err := c.Materials("local", "operation", id, boot, "skill", resource, "references/guide.md"); err == nil || calls != 3 {
		t.Fatal("a response after leaving the target was accepted")
	}
}

func TestMaterialsWorkOfflineAndRejectOldAgent(t *testing.T) {
	calls := 0
	oldAgent := false
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		calls++
		if oldAgent {
			return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
		}
		value := WorkspaceSnapshot{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot",
			Materials: &MaterialsView{List: &MaterialList{Items: []MaterialItem{}, Complete: true}}}
		data, _ := json.Marshal(value)
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	c.current.state.Summary.Cloud = "offline"
	got, err := c.Materials("local", "operation", "agent", "boot", "", "", "")
	if err != nil || got.Materials == nil || got.Materials.List == nil || calls != 1 {
		t.Fatalf("offline inventory: %+v (%v)", got, err)
	}
	c.current.state.Summary.Cloud = "online"
	got, err = c.Materials("local", "operation", "agent", "boot", "", "", "")
	if err != nil || got.Materials == nil || got.Materials.List == nil || len(got.Materials.List.Items) != 0 || calls != 2 {
		t.Fatalf("empty inventory after recovery: %+v (%v)", got, err)
	}
	oldAgent = true
	got, err = c.Materials("local", "operation", "agent", "boot", "", "", "")
	if err == nil || got.Materials != nil || calls != 3 {
		t.Fatalf("old Agent was treated as a successful empty inventory: %+v (%v)", got, err)
	}
}
