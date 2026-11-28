package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestResetAuthorizationAbortDoesNotStopOrExchange(t *testing.T) {
	for _, scenario := range []string{"denied", "cancelled", "expired", "boot_changed", "management_disconnected"} {
		t.Run(scenario, func(t *testing.T) {
			type callback struct{ redirect, state string }
			callbacks := make(chan callback, 1)
			var exchanges, cancelled, mutations atomic.Int32
			var origin string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/desktop-install/start":
					var input struct {
						Redirect string `json:"redirectUri"`
						State    string `json:"state"`
						Purpose  string `json:"purpose"`
						AgentID  string `json:"expectedAgentId"`
					}
					if json.NewDecoder(r.Body).Decode(&input) != nil || input.Purpose != "restore" || input.AgentID != "agent" {
						t.Error("reset authorization did not bind the original Agent")
					}
					callbacks <- callback{input.Redirect, input.State}
					expires := time.Now().Add(time.Minute)
					if scenario == "expired" {
						expires = time.Now().Add(500 * time.Millisecond)
					}
					w.WriteHeader(http.StatusCreated)
					_ = json.NewEncoder(w).Encode(authorizationIntent{RequestID: "test-request", AuthorizationURL: origin + "/auth/desktop-install?request_id=test-request", ExpiresAt: expires})
				case "/api/desktop-install/exchange":
					exchanges.Add(1)
					http.Error(w, "unexpected exchange", http.StatusInternalServerError)
				case "/api/desktop-install/cancel":
					cancelled.Add(1)
					w.WriteHeader(http.StatusNoContent)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			origin = server.URL
			facts := validTestFacts()
			facts.AgentID, facts.Service = "agent", "running"
			facts.Live = &Live{Protocol: Protocol, Profile: facts.Profile, Platform: facts.Platform, Arch: facts.Arch, Version: facts.Version, AgentID: "agent", BootID: "boot", Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				if command.Args[1] != "inspect" {
					mutations.Add(1)
					return environment.Result{}, errors.New("unexpected Agent mutation")
				}
				body, _ := json.Marshal(facts)
				return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(body)}, nil
			})
			c.origin = origin
			c.current.maintenanceAgent, c.current.maintenanceBoot = "agent", "boot"
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			open := func(string) error {
				cb := <-callbacks
				switch scenario {
				case "denied":
					values := url.Values{"state": {cb.state}, "error": {"access_denied"}}
					response, err := http.Get(cb.redirect + "?" + values.Encode())
					if err != nil {
						return err
					}
					return response.Body.Close()
				case "cancelled":
					cancel()
				case "boot_changed", "management_disconnected":
					if scenario == "boot_changed" {
						facts.Live.BootID = "new-boot"
					} else {
						facts.Live = nil
					}
					values := url.Values{"state": {cb.state}, "code": {"0123456789abcdef"}}
					response, err := http.Get(cb.redirect + "?" + values.Encode())
					if err != nil {
						return err
					}
					return response.Body.Close()
				}
				return nil
			}
			_, monitor := c.authorizationOperation(c.current, "reset", "en-US", open, ctx)
			stage, reason := "failed", "authorization_"+scenario
			if scenario == "boot_changed" || scenario == "management_disconnected" {
				stage, reason = "unknown", "authorization_target_changed"
			}
			if monitor || c.current.state.Stage != stage || c.current.state.Reason != reason {
				t.Fatalf("unexpected abort state: %+v", c.current.state)
			}
			if mutations.Load() != 0 || exchanges.Load() != 0 || cancelled.Load() != 1 {
				t.Fatalf("abort touched Agent or consumed credential: mutations=%d exchanges=%d cancellations=%d", mutations.Load(), exchanges.Load(), cancelled.Load())
			}
		})
	}
}
