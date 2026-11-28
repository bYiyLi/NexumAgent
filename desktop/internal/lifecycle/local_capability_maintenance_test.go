package lifecycle

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestLocalCapabilityMaintenanceNoApprovalAndRestartOnlyForNPM(t *testing.T) {
	for _, kind := range []string{"mcp", "openapi", "npm"} {
		t.Run(kind, func(t *testing.T) {
			var mu sync.Mutex
			calls := []string{}
			id, rev := "res_"+strings.Repeat("a", 64), strings.Repeat("b", 64)
			scope := capabilitywatch.Scope{TargetID: "local", OperationID: "operation", AgentID: "agent", BootID: "boot"}
			running := func(boot string) Facts {
				f := validTestFacts()
				f.AgentID = "agent"
				f.Service = "running"
				f.Live = &Live{Protocol: Protocol, Profile: f.Profile, Platform: f.Platform, Arch: f.Arch, Version: f.Version, AgentID: f.AgentID, BootID: boot, Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
				return f
			}
			stopped := running("boot")
			stopped.Service = "stopped"
			stopped.Live = nil
			facts := running("boot")
			marshal := func(v any) (environment.Result, error) {
				b, _ := json.Marshal(v)
				return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(b)}, nil
			}
			c := capabilityController(t, func(cmd environment.Command) (environment.Result, error) {
				mu.Lock()
				defer mu.Unlock()
				action := cmd.Args[1]
				calls = append(calls, action)
				switch action {
				case "capability-maintenance":
					if strings.Contains(strings.Join(cmd.Args, " "), "--capability-action check") {
						return marshal(map[string]any{"protocol": Protocol, "profile": "development", "agentId": "agent", "bootId": "boot", "request": localCapabilityRequest{Action: "check"}, "result": map[string]any{"status": "available", "restartRequired": false}})
					}
					if !strings.Contains(strings.Join(cmd.Args, " "), "--revision "+rev) || !strings.Contains(strings.Join(cmd.Args, " "), "--resource-id "+id) {
						return environment.Result{}, errors.New("wrong bound request")
					}
					return marshal(map[string]any{"protocol": Protocol, "profile": "development", "agentId": "agent", "bootId": "boot", "request": localCapabilityRequest{ResourceID: id, Revision: rev, Kind: kind, Action: "remove"}, "result": map[string]any{"status": "succeeded", "restartRequired": kind == "npm"}})
				case "inspect", "observe":
					return marshal(facts)
				case "maintenance-stop":
					facts = stopped
					return marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: "stopped"})
				case "start":
					facts = running("new-boot")
					return marshal(facts)
				case "capability-state":
					return marshal(capabilityStateWire{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: facts.Live.BootID, State: "available", Items: []capabilitywatch.Fact{}, PackageRevision: "1"})
				case "capability-packages":
					return marshal(capabilityPackagesWire{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: facts.Live.BootID, Revision: "1", State: "available", Items: []capabilitywatch.Fact{}})
				default:
					return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
				}
			})
			c.current.facts = facts
			c.current.state.Summary = classify(facts, testIdentity()).Summary
			c.current.cloudAgent, c.current.cloudBoot, c.current.cloudState, c.current.cloudObserved = "agent", "boot", "online", time.Now()
			if !c.LocalCapabilityMaintenanceAvailable(scope) {
				t.Fatal("local maintenance not available")
			}
			stale := scope
			stale.BootID = "stale"
			fact := capabilitywatch.Fact{ID: id, Name: "fixture", Type: kind, Revision: rev}
			done := make(chan [3]string, 1)
			finish := func(status, boot, code string) { done <- [3]string{status, boot, code} }
			if err := c.StartLocalCapabilityMaintenance(stale, fact, "remove", "", finish); err == nil {
				t.Fatal("stale target admitted")
			}
			if err := c.StartLocalCapabilityMaintenance(scope, fact, "remove", "", finish); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-done:
				expectedBoot := "boot"
				if kind == "npm" {
					expectedBoot = "new-boot"
				}
				if result[0] != "succeeded" || result[1] != expectedBoot {
					t.Fatalf("unexpected result %v", result)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("local maintenance did not finish")
			}
			mu.Lock()
			history := strings.Join(calls, ",")
			mu.Unlock()
			if kind == "npm" && !strings.Contains(history, "maintenance-stop,inspect,start") {
				t.Fatalf("restart sequence: %s", history)
			}
			if kind != "npm" && (strings.Contains(history, "maintenance-stop") || strings.Contains(history, ",start")) {
				t.Fatalf("hot removal restarted: %s", history)
			}
			if strings.Count(history, "capability-maintenance") != 2 {
				t.Fatalf("unexpected repeat: %s", history)
			}
			c.Close()
		})
	}
}

func TestLocalCapabilityMaintenanceRejectsUnavailableAndLostResult(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "old-native", true: "lost-result"}[lost], func(t *testing.T) {
			c := capabilityController(t, func(cmd environment.Command) (environment.Result, error) {
				if lost && cmd.Args[1] == "capability-maintenance" {
					return environment.Result{Started: true, OutcomeKnown: false}, errors.New("connection lost")
				}
				return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
			})
			scope := capabilitywatch.Scope{TargetID: "local", OperationID: "operation", AgentID: "agent", BootID: "boot"}
			if c.LocalCapabilityMaintenanceAvailable(scope) {
				t.Fatal("unavailable command admitted")
			}
		})
	}
}
