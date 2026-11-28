package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

func TestAuthorizationAfterUninstallRestoresOnlyTheBoundService(t *testing.T) {
	for _, scenario := range []string{"bound", "identity changed", "unbound"} {
		t.Run(scenario, func(t *testing.T) {
			type callback struct{ Redirect, State string }
			callbacks := make(chan callback, 1)
			var origin string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/desktop-install/start":
					var input struct {
						Redirect string `json:"redirectUri"`
						State    string `json:"state"`
						AgentID  string `json:"expectedAgentId"`
					}
					if json.NewDecoder(r.Body).Decode(&input) != nil {
						t.Error("invalid authorization request")
					}
					if scenario != "unbound" && input.AgentID != "agent-test" || scenario == "unbound" && input.AgentID != "" {
						t.Error("authorization was not bound to the known Agent")
					}
					callbacks <- callback{input.Redirect, input.State}
					w.WriteHeader(http.StatusCreated)
					_ = json.NewEncoder(w).Encode(authorizationIntent{RequestID: "test-request", AuthorizationURL: origin + "/auth/desktop-install?request_id=test-request", ExpiresAt: time.Now().Add(time.Minute)})
				case "/api/desktop-install/exchange":
					_ = json.NewEncoder(w).Encode(credential{AgentID: "agent-test", Profile: "development", Token: "test-token"})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			origin = server.URL
			facts := validTestFacts()
			facts.Service, facts.Config, facts.Credential = "missing", "unauthorized", "missing"
			if scenario == "unbound" {
				facts.Config, facts.Credential, facts.AgentID = "valid", "invalid", ""
			}
			repairs := 0
			c := capabilityController(t, func(command environment.Command) (environment.Result, error) {
				switch command.Args[1] {
				case "restore":
					input, _ := io.ReadAll(command.Stdin)
					if string(input) != "test-token\n" || strings.Contains(strings.Join(command.Args, " "), "test-token") {
						t.Error("credential was not restricted to stdin")
					}
					facts.Config, facts.Credential, facts.AgentID = "valid", "valid", "agent-test"
					if scenario == "identity changed" {
						facts.AgentID = "other-agent"
					}
				case "repair-service":
					repairs++
					facts.Service = "running"
					facts.Live = &Live{Protocol: Protocol, Profile: facts.Profile, Platform: facts.Platform, Arch: facts.Arch, Version: facts.Version, AgentID: facts.AgentID, BootID: "new-boot", Phase: "running", OriginMatches: true, CloudOnline: true, ExecutionReady: true}
				}
				body, _ := json.Marshal(facts)
				return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(body)}, nil
			})
			c.origin = origin
			open := func(string) error {
				cb := <-callbacks
				values := url.Values{"state": {cb.State}, "code": {"0123456789abcdef"}}
				response, err := http.Get(cb.Redirect + "?" + values.Encode())
				if err != nil {
					return err
				}
				return response.Body.Close()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			outcome, monitor := c.authorizationOperation(c.current, "configure", "en-US", open, ctx)
			switch scenario {
			case "bound":
				if !monitor || outcome.Stage != "ready" || repairs != 1 || outcome.Summary.AgentID != "agent-test" {
					t.Fatalf("bound restore did not start the original service: %+v repairs=%d", outcome, repairs)
				}
			case "identity changed":
				if monitor || repairs != 0 || c.current.state.Reason != "management_identity_mismatch" {
					t.Fatal("changed identity was allowed to repair the service")
				}
			case "unbound":
				if !monitor || repairs != 0 || outcome.Stage != "repair" {
					t.Fatalf("unbound restore unexpectedly registered a service: %+v repairs=%d", outcome, repairs)
				}
			}
		})
	}
}
