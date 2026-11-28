package capabilitywatch

import (
	"context"
	"sync"
	"time"
)

// Evaluator keeps the first client observation of a continuing condition. It
// never converts an absent or unknown fact into a confirmed failure.
type Evaluator struct {
	mu             sync.Mutex
	first          map[string]time.Time
	retry          map[string]time.Time
	checker        *NPMChecker
	now            func() time.Time
	registryBudget time.Duration
}

func NewEvaluator(checker *NPMChecker) *Evaluator {
	return &Evaluator{first: make(map[string]time.Time), retry: make(map[string]time.Time), checker: checker, now: time.Now, registryBudget: 2 * time.Second}
}

func (e *Evaluator) Evaluate(ctx context.Context, value Snapshot) Snapshot {
	return e.evaluate(ctx, value, true)
}

// EvaluateCached retains already-confirmed updates without making requests.
func (e *Evaluator) EvaluateCached(ctx context.Context, value Snapshot) Snapshot {
	return e.evaluate(ctx, value, false)
}

func (e *Evaluator) evaluate(ctx context.Context, value Snapshot, allowRegistry bool) Snapshot {
	alerts := make([]Alert, 0)
	active := make(map[string]bool)
	registryCtx, cancelRegistry := context.WithTimeout(ctx, e.registryBudget)
	defer cancelRegistry()
	addObserved := func(fact Fact, reason, level string) {
		key := value.Scope.TargetID + "\x00" + value.Scope.OperationID + "\x00" + value.Scope.AgentID + "\x00" + value.Scope.BootID + "\x00" + fact.ID + "\x00" + fact.Revision + "\x00" + reason
		active[key] = true
		e.mu.Lock()
		observed, ok := e.first[key]
		if !ok {
			observed = e.now().UTC()
			if at, err := time.Parse(time.RFC3339Nano, fact.ObservedAt); err == nil && !at.After(observed) {
				observed = at
			}
			e.first[key] = observed
		}
		e.mu.Unlock()
		alerts = append(alerts, Alert{ID: fact.ID, Level: level, Reason: reason, ObservedAt: observed.Format(time.RFC3339Nano)})
	}
	for _, fact := range value.Facts {
		if ctx.Err() != nil {
			return Snapshot{}
		}
		var reason string
		switch {
		case fact.Type == "mcp" && fact.State == "disconnected" && fact.Reason == "mcp_disconnected":
			reason = fact.Reason
		case (fact.Type == "mcp" || fact.Type == "openapi") && fact.State == "failed" &&
			(fact.Reason == "source_activation_failed" || fact.Reason == "mcp_managed_process_unavailable"):
			reason = fact.Reason
		case fact.Type == "npm" && fact.State == "failed" && fact.Reason == "extension_load_failed":
			reason = fact.Reason
		case fact.Type == "npm" && fact.State == "missing" && fact.Reason == "package_missing":
			reason = fact.Reason
		case fact.Type == "npm" && fact.State == "invalid" && fact.Reason == "package_invalid":
			reason = fact.Reason
		}
		if reason != "" {
			addObserved(fact, reason, "problem")
		}
		if fact.PendingConfig && (fact.Type == "mcp" || fact.Type == "openapi") {
			addObserved(fact, "configuration_pending_approval", "advice")
		}
		if fact.Type == "npm" && fact.Registry == "public" && e.checker != nil {
			release := PackageReleaseFacts{Name: fact.Name, InstalledVersion: fact.InstalledVersion, Registry: fact.Registry, Channel: fact.Channel}
			update, err := e.checker.Cached(release)
			key := fact.Name + "\x00" + fact.Channel
			e.mu.Lock()
			retryAt := e.retry[key]
			e.mu.Unlock()
			if err == nil && !update.Known && allowRegistry && registryCtx.Err() == nil && !e.now().Before(retryAt) {
				update, err = e.checker.Check(registryCtx, release)
				if err != nil && ctx.Err() == nil {
					e.mu.Lock()
					e.retry[key] = e.now().Add(time.Minute)
					e.mu.Unlock()
				}
			}
			if err == nil && update.Known && update.Available {
				alerts = append(alerts, Alert{ID: fact.ID, Level: "advice", Reason: "npm_update_available", Version: update.Version, ObservedAt: update.ObservedAt.UTC().Format(time.RFC3339Nano)})
			}
		}
	}
	e.mu.Lock()
	for key := range e.first {
		if !active[key] {
			delete(e.first, key)
		}
	}
	for key, retryAt := range e.retry {
		if !e.now().Before(retryAt) {
			delete(e.retry, key)
		}
	}
	e.mu.Unlock()
	value.Alerts, value.Severity = alerts, ""
	for _, alert := range alerts {
		if alert.Level == "problem" {
			value.Severity = "problem"
			break
		}
		if alert.Level == "advice" {
			value.Severity = "advice"
		}
	}
	return value
}
