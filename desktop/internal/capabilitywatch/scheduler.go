package capabilitywatch

import (
	"context"
	"sync"
	"time"
)

// Scope binds every observation to the admitted lifecycle session and boot.
type Scope struct {
	TargetID    string `json:"targetId"`
	OperationID string `json:"operationId"`
	AgentID     string `json:"agentId"`
	BootID      string `json:"bootId"`
}

type Fact struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Type             string `json:"type"`
	Revision         string `json:"revision,omitempty"`
	State            string `json:"state"`
	Reason           string `json:"reason,omitempty"`
	PendingConfig    bool   `json:"pendingConfig,omitempty"`
	ObservedAt       string `json:"observedAt,omitempty"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	Registry         string `json:"registry,omitempty"`
	Channel          string `json:"channel,omitempty"`
}

type Alert struct {
	ID         string `json:"id"`
	Level      string `json:"level"`
	Reason     string `json:"reason"`
	ObservedAt string `json:"observedAt"`
	Version    string `json:"version,omitempty"`
}

type Snapshot struct {
	Scope           Scope                 `json:"scope"`
	State           string                `json:"state"`
	Facts           []Fact                `json:"facts"`
	Alerts          []Alert               `json:"alerts"`
	Severity        string                `json:"severity,omitempty"`
	PackageRevision string                `json:"packageRevision,omitempty"`
	Operations      []MaintenanceProgress `json:"operations,omitempty"`
}

type MaintenanceProgress struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Revision  string `json:"revision"`
	Action    string `json:"action"`
	Version   string `json:"version,omitempty"`
	Status    string `json:"status"`
	ErrorCode string `json:"errorCode,omitempty"`
	Restarted bool   `json:"restarted,omitempty"`
}

type Reader func(context.Context, Scope) (Snapshot, error)

// Scheduler has exactly one reader goroutine. Reconfiguration cancels its
// current read; a new target is never read concurrently with the old one.
// Results from a hidden, stopped, or replaced scope are never published.
type Scheduler struct {
	mu         sync.Mutex
	scope      Scope
	active     bool
	visible    bool
	closed     bool
	generation uint64
	cancel     context.CancelFunc
	wake       chan struct{}
	done       chan struct{}
	interval   time.Duration
	read       Reader
	publish    func(Snapshot)
}

func NewScheduler(interval time.Duration, read Reader, publish func(Snapshot)) *Scheduler {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	s := &Scheduler{interval: interval, read: read, publish: publish, wake: make(chan struct{}, 1), done: make(chan struct{})}
	go s.run()
	return s
}

func (s *Scheduler) signalLocked() {
	s.generation++
	if s.cancel != nil {
		s.cancel()
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) Start(scope Scope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.active && s.scope == scope {
		return
	}
	s.scope, s.active = scope, true
	s.signalLocked()
}

func (s *Scheduler) Stop(scope Scope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.active || s.scope != scope {
		return
	}
	s.active = false
	s.signalLocked()
}

func (s *Scheduler) SetVisible(visible bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.visible == visible {
		return
	}
	s.visible = visible
	s.signalLocked()
}

func (s *Scheduler) Refresh(scope Scope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.active || s.scope != scope {
		return
	}
	s.signalLocked()
}

func (s *Scheduler) Close() {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		s.signalLocked()
	}
	s.mu.Unlock()
	<-s.done
}

func (s *Scheduler) run() {
	defer close(s.done)
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		if !s.active || !s.visible {
			s.mu.Unlock()
			<-s.wake
			continue
		}
		// Discard notifications already reflected in the locked state; otherwise
		// starting and showing together would cause an immediate duplicate read.
		select {
		case <-s.wake:
		default:
		}
		scope, generation := s.scope, s.generation
		ctx, cancel := context.WithCancel(context.Background())
		s.cancel = cancel
		s.mu.Unlock()

		started := time.Now()
		result, err := s.read(ctx, scope)
		cancel()
		s.mu.Lock()
		current := !s.closed && s.active && s.visible && s.scope == scope && s.generation == generation
		s.cancel = nil
		if current && err != nil {
			result = Snapshot{Scope: scope, State: "unavailable", Facts: []Fact{}, Alerts: []Alert{}}
		}
		if current {
			result.Scope = scope
			// Publish under the lock to establish ordering with Stop and target
			// changes. Callbacks must not synchronously call the scheduler.
			if s.publish != nil {
				s.publish(result)
			}
		}
		s.mu.Unlock()
		if !current {
			continue
		}
		delay := time.Until(started.Add(s.interval))
		if delay < 0 {
			delay = 0
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-s.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
	}
}
