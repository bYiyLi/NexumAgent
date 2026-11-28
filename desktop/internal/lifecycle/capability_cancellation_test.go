package lifecycle

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type cancellingCapabilityRuntime struct {
	fixtureRuntime
	started chan struct{}
}

func (r *cancellingCapabilityRuntime) Run(ctx context.Context, _ environment.Command) (environment.Result, error) {
	close(r.started)
	<-ctx.Done()
	return environment.Result{}, ctx.Err()
}

func TestCapabilityListAndDetailRespectClientCancellation(t *testing.T) {
	for _, detail := range []bool{false, true} {
		rt := &cancellingCapabilityRuntime{started: make(chan struct{})}
		c := New(func(string) (environment.Runtime, error) { return rt, nil }, "development", "https://example.test")
		sessionCtx, end := context.WithCancel(context.Background())
		c.current = &session{id: "local", operation: "op", rt: rt, ctx: sessionCtx, cancel: end, state: Snapshot{Stage: "ready", Summary: &Summary{AgentID: "agent", BootID: "boot"}}}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			if detail {
				_, err := c.CapabilityDetailContext(ctx, "local", "op", "agent", "boot", "res_"+strings.Repeat("a", 64))
				done <- err
				return
			}
			_, err := c.CapabilitiesContext(ctx, "local", "op", "agent", "boot")
			done <- err
		}()
		select {
		case <-rt.started:
		case <-time.After(time.Second):
			t.Fatal("read did not start")
		}
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("cancelled read succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("read did not stop")
		}
		end()
	}
}
