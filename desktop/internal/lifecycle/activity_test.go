package lifecycle

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

const testActivityRunID = "run_0123456789abcdef0123456789abcdef"

// The root Agent integration test runs this against its temporary real SQLite
// and same-user management endpoint with an actual locally built Native CLI.
func TestRealCLIActivity(t *testing.T) {
	binary, home := os.Getenv("NEXUM_TEST_DESKTOP_ACTIVITY_BINARY"), os.Getenv("NEXUM_TEST_DESKTOP_ACTIVITY_HOME")
	agent, boot, runID := os.Getenv("NEXUM_TEST_DESKTOP_ACTIVITY_AGENT"), os.Getenv("NEXUM_TEST_DESKTOP_ACTIVITY_BOOT"), os.Getenv("NEXUM_TEST_DESKTOP_ACTIVITY_RUN")
	if binary == "" || home == "" || agent == "" || boot == "" || runID == "" {
		t.Skip("isolated Agent CLI fixture is not running")
	}
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		process := exec.CommandContext(context.Background(), binary, command.Args...)
		process.Env = append(os.Environ(), "HOME="+home)
		output, err := process.Output()
		if err != nil {
			return environment.Result{}, err
		}
		return environment.Result{OutcomeKnown: true, Stdout: string(output)}, nil
	})
	c.current.state.Summary.AgentID, c.current.state.Summary.BootID = agent, boot
	list, err := c.Activity("local", "operation", agent, boot, "list", "", "", "", 0)
	if err != nil || list.Activity.List == nil || len(list.Activity.List.Runs) != 1 || list.Activity.List.Runs[0].RunID != runID {
		t.Fatalf("real CLI list: %+v %v", list, err)
	}
	detail, err := c.Activity("local", "operation", agent, boot, "detail", runID, "", "", 0)
	if err != nil || detail.Activity.Detail == nil || detail.Activity.Detail.Run.RunID != runID || !strings.Contains(string(detail.Activity.Detail.Result), "report.txt") {
		t.Fatalf("real CLI detail: %+v %v", detail, err)
	}
	for _, kind := range []string{"code", "input", "logs"} {
		part, err := c.Activity("local", "operation", agent, boot, "part", runID, "", kind, 0)
		if err != nil || part.Activity.Part == nil || part.Activity.Part.Kind != kind || part.Activity.Part.Text == "" {
			t.Fatalf("real CLI %s: %+v %v", kind, part, err)
		}
	}
}

func TestActivityUsesVerifiedTargetAndProjectsOnlyRunFields(t *testing.T) {
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if strings.Join(command.Args, " ") != "desktop activity --profile development --server https://example.test --agent-id agent --boot-id boot --activity-action list" ||
			command.Program != "/test-home/.nexum-dev/bin/nexum-agent" || command.Stdin != nil {
			t.Fatal("unexpected activity command", command)
		}
		return environment.Result{OutcomeKnown: true, Stdout: `{"protocol":1,"profile":"development","agentId":"agent","bootId":"boot","activity":{"list":{"runs":[{"runId":"` + testActivityRunID + `","title":"Actual Run","status":"running","source":"inline","scriptName":null,"projectId":null,"acceptedAt":"2026-11-27T12:00:00Z","startedAt":null,"finishedAt":null,"error":null,"availability":{"code":true,"input":true,"logs":true,"result":false},"privateField":"must-be-discarded"}],"nextCursor":null,"partial":false,"observedAt":"2026-11-27T12:00:00Z"}}}`}, nil
	})
	got, err := c.Activity("local", "operation", "agent", "boot", "list", "", "", "", 0)
	if err != nil || got.TargetID != "local" || got.OperationID != "operation" || got.Activity.List == nil || len(got.Activity.List.Runs) != 1 {
		t.Fatalf("list: %+v %v", got, err)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "privateField") || strings.Contains(string(raw), "must-be-discarded") {
		t.Fatal("unrecognized Agent fields reached frontend")
	}
	for _, scope := range [][4]string{{"other", "operation", "agent", "boot"}, {"local", "old", "agent", "boot"}, {"local", "operation", "other", "boot"}, {"local", "operation", "agent", "old"}} {
		if _, err := c.Activity(scope[0], scope[1], scope[2], scope[3], "list", "", "", "", 0); err == nil {
			t.Fatal("stale scope admitted", scope)
		}
	}
}

func TestActivityRejectsInvalidRequestsAndChangedTargets(t *testing.T) {
	var c *Controller
	c = capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if !strings.Contains(strings.Join(command.Args, " "), "--run-id "+testActivityRunID+" --part code --offset 0 --max-bytes 16384") {
			t.Fatal("unexpected activity request", command)
		}
		c.Leave("local", "operation")
		return environment.Result{OutcomeKnown: true, Stdout: `{"protocol":1,"profile":"development","agentId":"agent","bootId":"boot","activity":{"part":{"kind":"code","offset":0,"nextOffset":3,"size":3,"complete":true,"text":"abc"}}}`}, nil
	})
	if _, err := c.Activity("local", "operation", "agent", "boot", "part", "../../secret", "", "code", 0); err == nil {
		t.Fatal("invalid Run ID admitted")
	}
	if _, err := c.Activity("local", "operation", "agent", "boot", "part", testActivityRunID, "", "result", 0); err == nil {
		t.Fatal("arbitrary snapshot kind admitted")
	}
	if _, err := c.Activity("local", "operation", "agent", "boot", "part", testActivityRunID, "", "code", 0); err == nil {
		t.Fatal("response admitted after target changed")
	}
}
