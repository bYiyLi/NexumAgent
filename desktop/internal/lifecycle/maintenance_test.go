package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestMaintenanceRequiresCurrentRevisionAndIdentity(t *testing.T) {
	var calls atomic.Int32
	c := capabilityController(t, func(environment.Command) (environment.Result, error) {
		calls.Add(1)
		return environment.Result{}, errors.New("unexpected execution")
	})
	c.current.state.Revision = 7
	for _, input := range []struct {
		revision uint64
		agent    string
		boot     string
		action   string
	}{
		{6, "agent", "boot", "stop"},
		{7, "other", "boot", "stop"},
		{7, "agent", "old-boot", "stop"},
		{7, "agent", "boot", "unknown"},
	} {
		if _, err := c.BeginAgentMaintenance("local", "operation", input.revision, input.agent, input.boot, input.action, "", nil); err == nil {
			t.Fatalf("accepted invalid maintenance target: %+v", input)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid action reached the Agent")
	}
}

func TestMaintenanceAvailabilityRejectsOldAgentAndChangedIdentity(t *testing.T) {
	old := false
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] != "maintenance-check" {
			t.Fatalf("unexpected command: %v", command.Args)
		}
		if old {
			return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
		}
		data, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: "available"})
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	if available, err := c.MaintenanceAvailable("local", "operation", "agent", "boot"); err != nil || !available {
		t.Fatalf("new Agent was not recognized: %v, %v", available, err)
	}
	if _, err := c.MaintenanceAvailable("local", "operation", "agent", "old-boot"); err == nil {
		t.Fatal("accepted an old boot")
	}
	old = true
	if available, err := c.MaintenanceAvailable("local", "operation", "agent", "boot"); err == nil || available {
		t.Fatal("old Agent was treated as supporting maintenance")
	}
}

func TestRestartDoesNotStopAgentWhileCloudIsOffline(t *testing.T) {
	var calls atomic.Int32
	c := capabilityController(t, func(environment.Command) (environment.Result, error) {
		calls.Add(1)
		return environment.Result{}, errors.New("unexpected execution")
	})
	c.current.state.Revision = 7
	c.current.state.Summary.Cloud = "offline"
	if _, err := c.BeginAgentMaintenance("local", "operation", 7, "agent", "boot", "restart", "", nil); err == nil || err.Error() != "maintenance_cloud_required" {
		t.Fatalf("offline restart was not blocked: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("offline restart stopped the running Agent")
	}
}

func TestMaintenanceDiscardsObservationsFromBeforeTheOperation(t *testing.T) {
	c := capabilityController(t, func(environment.Command) (environment.Result, error) {
		return environment.Result{}, errors.New("unexpected execution")
	})
	s := c.current
	s.observation = 5
	s.state.Stage = "stopping"
	c.mutation = s
	old := outcome("ready", "management_verified", validTestFacts())
	if c.publishObservation(s, 5, old) {
		t.Fatal("an observation overwrote an in-progress maintenance operation")
	}
	c.mutation = nil
	s.observation++
	if c.publishObservation(s, 5, old) {
		t.Fatal("an old observation was accepted after maintenance settled")
	}
	if !c.publishObservation(s, 6, old) {
		t.Fatal("the current observation was rejected")
	}
	c.Leave("local", "operation")
	if c.publishObservation(s, 6, old) {
		t.Fatal("a response for a target that was left was accepted")
	}
}

func TestRestartPreservesVerifiedNameAcrossObservations(t *testing.T) {
	facts := validTestFacts()
	facts.Service, facts.AgentName = "running", facts.AgentID
	facts.Live = &Live{Protocol: Protocol, Profile: facts.Profile, Platform: facts.Platform, Arch: facts.Arch, Version: facts.Version,
		AgentID: facts.AgentID, BootID: "new-boot", Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] == "cloud-status" {
			return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
		}
		if command.Args[1] != "observe" {
			t.Fatalf("unexpected command: %v", command.Args)
		}
		body, _ := json.Marshal(facts)
		return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(body)}, nil
	})
	s := c.current
	c.mutation = s
	s.state.Stage, s.state.Busy = "connecting", true
	before := Outcome{Facts: facts, Summary: &Summary{AgentID: facts.AgentID, BootID: "old-boot", Name: "Test Mac"}}
	ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
	defer cancel()
	go c.waitForMaintenanceReady(ctx, s, facts.AgentID, "old-boot", facts.Version, before, Outcome{})
	deadline := time.Now().Add(7 * time.Second)
	observations := 0
	var revision uint64
	for time.Now().Before(deadline) {
		state, err := c.Get("local")
		if err != nil {
			t.Fatal(err)
		}
		if state.Stage == "ready" && !state.Busy && state.Summary != nil && state.Revision != revision {
			if state.Summary.Name != "Test Mac" {
				t.Fatalf("verified name lost: %q", state.Summary.Name)
			}
			revision = state.Revision
			observations++
			if observations >= 2 {
				c.Leave("local", "operation")
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("restart did not publish and retain the verified name")
}

func TestResetExchangesOnlyAfterConfirmedStop(t *testing.T) {
	for _, scenario := range []string{"busy", "restored", "exchange_failure"} {
		t.Run(scenario, func(t *testing.T) {
			var exchanges atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				exchanges.Add(1)
				if scenario == "exchange_failure" {
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
					return
				}
				_ = json.NewEncoder(w).Encode(credential{AgentID: "agent", Profile: "development", Token: "test-token"})
			}))
			defer server.Close()
			received := make(chan string, 1)
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if command.Args[1] != "maintenance-restore" {
					t.Fatalf("unexpected command: %v", command.Args)
				}
				state := "restored"
				if scenario == "busy" {
					command.Progress("maintenance_busy")
					state = "busy"
				} else {
					command.Progress("stop_verify")
					body, _ := io.ReadAll(command.Stdin)
					received <- string(body)
				}
				data, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: state})
				return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(data)}, nil
			})
			a := &authorization{origin: server.URL, profile: "development", requestID: "req", verifier: "verifier", redirect: "http://127.0.0.1", expires: time.Now().Add(time.Minute)}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			state, err := c.resetConnection(ctx, c.current, a, "code", "agent", "boot")
			switch scenario {
			case "busy":
				if err != nil || state != "busy" || exchanges.Load() != 0 {
					t.Fatalf("busy reset exchanged credentials: %q, %v, %d", state, err, exchanges.Load())
				}
			case "restored":
				if err != nil || state != "restored" || exchanges.Load() != 1 {
					t.Fatalf("reset failed: %q, %v, %d", state, err, exchanges.Load())
				}
				if token := <-received; token != "test-token\n" {
					t.Fatal("credential was not delivered through stdin")
				}
			case "exchange_failure":
				if err == nil || !strings.Contains(err.Error(), "exchange") || exchanges.Load() != 1 {
					t.Fatalf("exchange failure was not preserved: %q, %v", state, err)
				}
				if token := <-received; token != "" {
					t.Fatal("failed exchange delivered a credential")
				}
			}
		})
	}
}

func TestMaintenanceBusyAndUnknownNeverReplayStop(t *testing.T) {
	for _, scenario := range []string{"busy", "unknown"} {
		t.Run(scenario, func(t *testing.T) {
			var calls atomic.Int32
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if command.Args[1] == "cloud-status" {
					return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
				}
				if command.Args[1] != "maintenance-stop" {
					t.Fatalf("unexpected command: %v", command.Args)
				}
				calls.Add(1)
				if scenario == "unknown" {
					return environment.Result{Started: true}, environment.ErrUnknownOutcome
				}
				result := maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: "busy"}
				data, _ := json.Marshal(result)
				return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
			})
			c.current.state.Revision = 7
			if _, err := c.BeginAgentMaintenance("local", "operation", 7, "agent", "boot", "stop", "", nil); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				snapshot, err := c.Get("local")
				if err != nil {
					t.Fatal(err)
				}
				if !snapshot.Busy {
					if scenario == "busy" && (snapshot.Stage != "ready" || snapshot.Reason != "maintenance_busy") ||
						scenario == "unknown" && (snapshot.Stage != "unknown" || snapshot.Reason != "maintenance_outcome_unknown") {
						t.Fatalf("unexpected outcome: %+v", snapshot)
					}
					if calls.Load() != 1 {
						t.Fatalf("stop executed %d times", calls.Load())
					}
					return
				}
				time.Sleep(time.Millisecond)
			}
			t.Fatal("maintenance did not settle")
		})
	}
}
