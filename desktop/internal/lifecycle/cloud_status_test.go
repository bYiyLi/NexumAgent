package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestCloudStatusRequiresFreshMatchingBootEvidence(t *testing.T) {
	c := capabilityController(t, func(environment.Command) (environment.Result, error) {
		return environment.Result{}, errors.New("unexpected command")
	})
	s := c.current
	facts := validTestFacts()
	facts.AgentID = "agent"
	facts.Live = &Live{AgentID: "agent", BootID: "boot", CloudOnline: true}
	summary := &Summary{AgentID: "agent", BootID: "boot", Cloud: "online"}
	publish := func() string {
		c.publishLocked(s, "ready", "", facts, summary)
		return s.state.Summary.Cloud
	}
	if got := publish(); got != "unknown" {
		t.Fatalf("local socket alone was reported as %s", got)
	}
	s.cloudAgent, s.cloudBoot, s.cloudState, s.cloudObserved = "agent", "boot", "online", time.Now()
	if got := publish(); got != "online" {
		t.Fatalf("matching Cloud observation reported %s", got)
	}
	s.cloudState = "offline"
	if got := publish(); got != "offline" {
		t.Fatalf("Cloud disconnect did not override stale local socket: %s", got)
	}
	s.cloudState, s.cloudObserved = "online", time.Now().Add(-cloudStatusMaxAge-time.Second)
	if got := publish(); got != "unknown" {
		t.Fatalf("expired observation reported %s", got)
	}
	s.cloudObserved, s.cloudBoot = time.Now(), "old-boot"
	if got := publish(); got != "unknown" {
		t.Fatalf("other boot's observation reported %s", got)
	}
	s.cloudBoot = "boot"
	facts.Live.CloudOnline = false
	if got := publish(); got != "offline" {
		t.Fatalf("local disconnect reported %s", got)
	}
	facts.Live.CloudOnline = true
	if got := publish(); got != "unknown" {
		t.Fatalf("reconnection reused old evidence: %s", got)
	}
	if summary.Cloud != "online" {
		t.Fatal("publication mutated the caller's summary")
	}
}

func TestCloudStatusRejectsMalformedAndWrongIdentityResults(t *testing.T) {
	for _, scenario := range []string{"online", "offline", "unknown", "old_native", "wrong_boot", "wrong_agent", "extra"} {
		t.Run(scenario, func(t *testing.T) {
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if command.Args[1] != "cloud-status" {
					t.Fatal("unexpected command")
				}
				if scenario == "old_native" {
					return environment.Result{OutcomeKnown: true, ExitCode: 2}, nil
				}
				result := maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: scenario}
				if scenario == "wrong_boot" {
					result.BootID, result.State = "old-boot", "online"
				}
				if scenario == "wrong_agent" {
					result.AgentID, result.State = "other", "online"
				}
				if scenario == "extra" {
					result.State = "online"
				}
				data, _ := json.Marshal(result)
				if scenario == "extra" {
					data = append(data, []byte(` {"unexpected":true}`)...)
				}
				return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
			})
			want := scenario
			if scenario != "online" && scenario != "offline" {
				want = "unknown"
			}
			if got := c.readCloudStatus(context.Background(), c.current, "agent", "boot"); got != want {
				t.Fatalf("status=%s want=%s", got, want)
			}
		})
	}
}

func TestCloudMonitorPublishesCloudDisconnectWithoutStoppingAgent(t *testing.T) {
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] != "cloud-status" {
			t.Fatalf("unexpected command: %v", command.Args)
		}
		data, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: "offline"})
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	s := c.current
	s.facts = validTestFacts()
	s.facts.AgentID = "agent"
	s.facts.Live = &Live{AgentID: "agent", BootID: "boot", CloudOnline: true}
	s.observation = 1
	s.state.Summary = &Summary{AgentID: "agent", BootID: "boot", Cloud: "online"}
	go c.observeCloud(s, 1)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state, err := c.Get("local")
		if err == nil && state.Summary != nil && state.Summary.Cloud == "offline" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Cloud's offline result was not published")
}

func TestCloudMonitorDiscardsResponseAfterTargetChanges(t *testing.T) {
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] != "cloud-status" {
			return environment.Result{}, errors.New("unexpected command")
		}
		close(started)
		<-release
		data, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: "online"})
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	s := c.current
	s.facts = validTestFacts()
	s.facts.AgentID = "agent"
	s.facts.Live = &Live{AgentID: "agent", BootID: "boot", CloudOnline: true}
	s.observation = 1
	s.state.Summary = &Summary{AgentID: "agent", BootID: "boot", Cloud: "unknown"}
	go func() { defer close(done); c.observeCloud(s, 1) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("Cloud query did not start")
	}
	c.mu.Lock()
	s.observation++
	s.state.Summary = &Summary{AgentID: "agent", BootID: "new-boot", Cloud: "unknown"}
	c.mu.Unlock()
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("old Cloud monitor did not stop")
	}
	state, err := c.Get("local")
	if err != nil || state.Summary == nil || state.Summary.BootID != "new-boot" || state.Summary.Cloud != "unknown" {
		t.Fatalf("stale Cloud result was published: %+v, %v", state, err)
	}
}

func TestCloudMonitorUpdatesAfterCloudDropsAnOtherwiseLiveBoot(t *testing.T) {
	var online atomic.Bool
	online.Store(true)
	c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
		if command.Args[1] != "cloud-status" {
			return environment.Result{}, errors.New("unexpected Agent mutation")
		}
		status := "offline"
		if online.Load() {
			status = "online"
		}
		data, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent", BootID: "boot", State: status})
		return environment.Result{OutcomeKnown: true, Stdout: string(data)}, nil
	})
	s := c.current
	s.facts = validTestFacts()
	s.facts.AgentID = "agent"
	s.facts.Live = &Live{AgentID: "agent", BootID: "boot", CloudOnline: true}
	s.observation = 1
	s.state.Summary = &Summary{AgentID: "agent", BootID: "boot", Cloud: "unknown"}
	go c.observeCloud(s, 1)
	wait := func(want string, limit time.Duration) bool {
		deadline := time.Now().Add(limit)
		for time.Now().Before(deadline) {
			state, err := c.Get("local")
			if err == nil && state.Summary != nil && state.Summary.Cloud == want {
				return true
			}
			time.Sleep(10 * time.Millisecond)
		}
		return false
	}
	if !wait("online", 2*time.Second) {
		t.Fatal("initial Cloud status was not published")
	}
	online.Store(false)
	started := time.Now()
	if !wait("offline", cloudStatusInterval+2*time.Second) {
		t.Fatal("Cloud disconnect was not observed while the local socket remained live")
	}
	t.Logf("Cloud disconnect reflected after %s without stopping the Agent", time.Since(started).Round(time.Millisecond))
}
