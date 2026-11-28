package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"slices"
	"testing"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type reinstallFixtureRuntime struct {
	environment.Runtime
	legacy  bool
	calls   int
	sawFull bool
}

func (r *reinstallFixtureRuntime) Run(ctx context.Context, c environment.Command) (environment.Result, error) {
	if len(c.Args) >= 2 && c.Args[0] == "desktop" && c.Args[1] == "maintenance-reinstall" {
		r.calls++
		r.sawFull = slices.Contains(c.Args, "--full-runtime")
		if r.legacy {
			return environment.Result{Started: true, OutcomeKnown: true, ExitCode: 2, Stderr: "desktop_management_command_failed"}, nil
		}
		c.Progress("reinstall_prepare")
		c.Progress("runtime:node_download:5:10")
		body, _ := json.Marshal(maintenanceStopResult{Protocol: Protocol, Profile: "development", AgentID: "agent-test", BootID: "boot", State: "runtime_prepare_failed"})
		return environment.Result{Started: true, OutcomeKnown: true, Stdout: string(body)}, nil
	}
	return r.Runtime.Run(ctx, c)
}

func TestReinstallRequiresFullRuntimeHelperAndDoesNotReplay(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix target downloader fixture")
	}
	for _, legacy := range []bool{false, true} {
		name := "preparation failure"
		if legacy {
			name = "old helper"
		}
		t.Run(name, func(t *testing.T) {
			target := localTarget(t)
			rt := &reinstallFixtureRuntime{Runtime: target, legacy: legacy}
			id := rt.Identity()
			file := "nexum-agent-" + id.Platform + "-" + id.Arch
			payload := []byte("fixture verified Native artifact")
			hash := sha256.Sum256(payload)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/agent/native/manifest.json":
					_ = json.NewEncoder(w).Encode(manifest{Version: "1.2.3", Artifacts: []artifact{{OS: id.Platform, Arch: id.Arch, Name: file, SHA256: hex.EncodeToString(hash[:]), Size: int64(len(payload))}}})
				case "/agent/native/" + file:
					_, _ = w.Write(payload)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", server.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s := &session{rt: rt, id: "local", operation: "operation", ctx: ctx, cancel: cancel}
			c.current = s
			c.mutation = s
			before := outcome("ready", "", validTestFacts())
			c.runInstallChange(s, "reinstall", "agent-test", "boot", before)
			if rt.calls != 1 || !rt.sawFull {
				t.Fatalf("unsafe fallback: calls=%d full=%v", rt.calls, rt.sawFull)
			}
			got, err := c.Get("local")
			if err != nil {
				t.Fatal(err)
			}
			if got.Busy || got.RuntimeProgress != nil || got.Progress != nil {
				t.Fatalf("stale state after failure: %+v", got)
			}
			if legacy {
				if got.Stage != "unknown" || got.Reason != "maintenance_outcome_unknown" {
					t.Fatalf("unexpected legacy outcome: %+v", got)
				}
			} else {
				if got.Stage != "blocked" || got.Reason != "runtime_prepare_failed" || !slices.Contains(got.ObservedStages, "runtime:node_download") {
					t.Fatalf("unexpected prepare failure: %+v", got)
				}
			}
		})
	}
}
