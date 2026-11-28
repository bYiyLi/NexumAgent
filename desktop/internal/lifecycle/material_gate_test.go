package lifecycle

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestOnlineMaterialsStopOfflineAndDiscardDisconnectResponse(t *testing.T) {
	var c *Controller
	calls := 0
	disconnect := false
	c = capabilityController(t, func(environment.Command) (environment.Result, error) {
		calls++
		view := WorkspaceSnapshot{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot",
			Materials: &MaterialsView{List: &MaterialList{Items: []MaterialItem{}, Complete: true}}}
		data, _ := json.Marshal(view)
		if disconnect {
			c.mu.Lock()
			c.current.state.Summary.Cloud = "offline"
			c.mu.Unlock()
		}
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	c.current.state.Summary.Cloud = "offline"
	read := func() (WorkspaceSnapshot, error) {
		return c.OnlineMaterialsContext(context.Background(), "local", "operation", "agent", "boot", "", "", "")
	}
	if _, err := read(); err == nil || calls != 0 {
		t.Fatal("offline Desktop inspection reached the target")
	}
	c.current.state.Summary.Cloud = "online"
	disconnect = true
	if got, err := read(); err == nil || got.Materials != nil || calls != 1 {
		t.Fatalf("response after disconnect was accepted: %+v (%v)", got, err)
	}
	c.current.state.Summary.Cloud = "online"
	disconnect = false
	if got, err := read(); err != nil || got.Materials == nil || calls != 2 {
		t.Fatalf("inspection did not recover: %+v (%v)", got, err)
	}
}
