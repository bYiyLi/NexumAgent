package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

type Snapshot struct {
	Revision          uint64            `json:"revision"`
	TargetID          string            `json:"targetId"`
	OperationID       string            `json:"operationId"`
	Stage             string            `json:"stage"`
	Reason            string            `json:"reason"`
	Version           string            `json:"version"`
	RequiredVersion   string            `json:"requiredVersion"`
	Busy              bool              `json:"busy"`
	Summary           *Summary          `json:"summary"`
	Progress          *TransferProgress `json:"progress,omitempty"`
	RuntimeProgress   *TransferProgress `json:"runtimeProgress,omitempty"`
	ObservedStages    []string          `json:"observedStages,omitempty"`
	WaitingForRuntime bool              `json:"waitingForRuntime"`
}
type Resolver func(string) (environment.Runtime, error)
type session struct {
	rt                  environment.Runtime
	id, operation       string
	ctx                 context.Context
	cancel              context.CancelFunc
	state               Snapshot
	facts               Facts
	authorizationCancel context.CancelFunc
	authorizationURL    string
	observation         uint64
	maintenanceAgent    string
	maintenanceBoot     string
	cloudAgent          string
	cloudBoot           string
	cloudState          string
	cloudObserved       time.Time
	observedStages      []string
	progress            *TransferProgress
	runtimeBoot         string
	runtimeWaitSince    time.Time
	runtimeSeenReady    bool
	runtimeWaitExpired  bool
}
type Controller struct {
	mu              sync.Mutex
	resolve         Resolver
	profile, origin string
	revision        uint64
	current         *session
	mutation        *session
	closed          bool
}

func New(resolve Resolver, profile, origin string) *Controller {
	return &Controller{resolve: resolve, profile: profile, origin: origin, revision: 1}
}
func newOperation() (string, error) {
	var b [16]byte
	_, e := rand.Read(b[:])
	return hex.EncodeToString(b[:]), e
}
func (c *Controller) validLocked(s *session) bool {
	if c.closed || c.current != s || s.ctx.Err() != nil || !s.rt.Alive() {
		return false
	}
	rt, e := c.resolve(s.id)
	return e == nil && rt == s.rt
}

const runtimeWaitLimit = 10 * time.Minute

func (c *Controller) beginMutationLocked(s *session) {
	c.mutation = s
	s.observedStages = nil
	s.progress = nil
	s.facts.RuntimeProgress = nil
}
func runtimePreparing(p *TransferProgress) bool {
	return p != nil && oneOf(p.Stage, "node_check", "node_download", "node_install", "pnpm_prepare", "host_check", "host_download", "host_install", "host_start", "host_configure")
}

// Record observed stages, not inferred completion of skipped stages.
func (s *session) recordStage(stage string) {
	if n := len(s.observedStages); n > 0 && s.observedStages[n-1] == stage {
		return
	}
	s.observedStages = append(s.observedStages, stage)
	if len(s.observedStages) > 32 {
		s.observedStages = s.observedStages[len(s.observedStages)-32:]
	}
}
func (c *Controller) publishLocked(s *session, stage, reason string, f Facts, summary *Summary) {
	if s.state.Stage != stage {
		s.progress = nil
		if !oneOf(stage, "ready", "failed", "unknown", "blocked", "network") {
			s.recordStage(stage)
		}
	}
	if !oneOf(stage, "install_readiness", "reinstall_prepare", "connecting", "ready", "upgrade") {
		f.RuntimeProgress = nil
	}
	if p := f.RuntimeProgress; p != nil && !oneOf(p.Stage, "ready", "unknown") {
		if strings.HasPrefix(p.Stage, "agent_upgrade_") == (stage == "upgrade") {
			s.recordStage("runtime:" + p.Stage)
		}
	}
	waitingForRuntime := false
	if f.Live != nil && f.Live.OriginMatches && f.Live.BootID != "" && stage == "ready" {
		if s.runtimeBoot != f.Live.BootID {
			s.runtimeBoot, s.runtimeWaitSince, s.runtimeSeenReady, s.runtimeWaitExpired = f.Live.BootID, time.Now(), false, false
		}
		if f.Live.ExecutionReady {
			s.runtimeSeenReady = true
		}
		if time.Since(s.runtimeWaitSince) >= runtimeWaitLimit || !f.Live.ExecutionReady && !runtimePreparing(f.RuntimeProgress) {
			s.runtimeWaitExpired = true
		}
		waitingForRuntime = !s.runtimeSeenReady && !s.runtimeWaitExpired && !f.Live.ExecutionReady && runtimePreparing(f.RuntimeProgress)
	}
	if stage == "ready" && summary != nil {
		copy := *summary
		copy.Cloud = "unknown"
		if f.Live != nil && !f.Live.CloudOnline {
			copy.Cloud = "offline"
			s.cloudObserved = time.Time{}
		} else if s.cloudAgent == copy.AgentID && s.cloudBoot == copy.BootID &&
			!s.cloudObserved.IsZero() && time.Since(s.cloudObserved) <= cloudStatusMaxAge {
			copy.Cloud = s.cloudState
		}
		summary = &copy
	} else {
		s.cloudObserved = time.Time{}
	}
	c.revision++
	s.state = Snapshot{Revision: c.revision, TargetID: s.id, OperationID: s.operation, Stage: stage, Reason: reason, Version: f.Version, RequiredVersion: f.RequiredVersion, Summary: summary, Busy: c.mutation != nil, Progress: s.progress, RuntimeProgress: f.RuntimeProgress, ObservedStages: append([]string(nil), s.observedStages...), WaitingForRuntime: waitingForRuntime}
	s.facts = f
}
func (c *Controller) publish(s *session, o Outcome) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.validLocked(s) {
		return false
	}
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	return true
}

// An observation begun before a mutation must not overwrite its progress.
func (c *Controller) publishObservation(s *session, generation uint64, o Outcome) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.validLocked(s) || c.mutation != nil || s.observation != generation {
		return false
	}
	c.publishLocked(s, o.Stage, o.Reason, o.Facts, o.Summary)
	return true
}
func (c *Controller) phase(s *session, stage string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.validLocked(s) {
		if name, done, total, ok := environment.ParseDesktopRuntimeProgress(stage); ok {
			if !oneOf(s.state.Stage, "install_readiness", "reinstall_prepare") || c.mutation != s {
				return
			}
			f := s.facts
			f.RuntimeProgress = &TransferProgress{Stage: name, DownloadedBytes: done, TotalBytes: total}
			c.publishLocked(s, s.state.Stage, "", f, nil)
			return
		}
		if name, done, total, ok := environment.ParseDesktopProgress(stage); ok && total > 0 {
			if s.state.Stage != name || s.progress != nil && (s.progress.TotalBytes != total || done < s.progress.DownloadedBytes) {
				return
			}
			s.progress = &TransferProgress{Stage: name, DownloadedBytes: done, TotalBytes: total}
			stage = name
		}
		c.publishLocked(s, stage, "", s.facts, nil)
	}
}
func (c *Controller) Check(id string) (Snapshot, error) {
	rt, e := c.resolve(id)
	if e != nil || !rt.Alive() {
		return Snapshot{}, errors.New("environment_disconnected")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Snapshot{}, errors.New("lifecycle_closed")
	}
	if c.mutation != nil {
		return Snapshot{}, errors.New("lifecycle_operation_in_progress")
	}
	if c.current != nil {
		c.current.cancel()
	}
	op, e := newOperation()
	if e != nil {
		return Snapshot{}, errors.New("lifecycle_unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{rt: rt, id: id, operation: op, ctx: ctx, cancel: cancel}
	c.current = s
	c.publishLocked(s, "system", "", Facts{}, nil)
	go c.runCheck(s)
	return s.state, nil
}
func (c *Controller) Get(id string) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id {
		return Snapshot{}, errors.New("lifecycle_check_required")
	}
	if !c.validLocked(s) {
		return Snapshot{}, errors.New("environment_changed")
	}
	return s.state, nil
}
func (c *Controller) runCheck(s *session) {
	ctx, cancel := context.WithTimeout(s.ctx, 45*time.Second)
	o := probe(ctx, s.rt, c.profile, c.origin, "inspect", func(p string) { c.phase(s, p) })
	cancel()
	if !c.publish(s, o) {
		return
	}
	c.observe(s, o, false)
}
func (c *Controller) Start(id, operation string, revision uint64) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation || s.state.Revision != revision || s.state.Stage != "start" || !c.validLocked(s) || c.mutation != nil {
		return Snapshot{}, errors.New("lifecycle_check_required")
	}
	c.beginMutationLocked(s)
	c.publishLocked(s, "starting", "", s.facts, nil)
	go c.runStart(s)
	return s.state, nil
}
func (c *Controller) endMutation(s *session) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.mutation == s {
		c.mutation = nil
		if c.current == s {
			c.publishLocked(s, s.state.Stage, s.state.Reason, s.facts, s.state.Summary)
		}
	}
}
func (c *Controller) runStart(s *session) {
	// Re-check native facts at admission, then the Agent helper itself repeats
	// service/config/credential checks before submitting to the OS supervisor.
	ctx, cancel := context.WithTimeout(s.ctx, 80*time.Second)
	before := probe(ctx, s.rt, c.profile, c.origin, "inspect", nil)
	if before.Stage != "start" {
		cancel()
		c.publish(s, before)
		c.endMutation(s)
		c.observe(s, before, false)
		return
	}
	if !c.publish(s, outcome("starting", "", before.Facts)) {
		cancel()
		c.endMutation(s)
		return
	}
	after := probe(ctx, s.rt, c.profile, c.origin, "start", func(stage string) { c.phase(s, stage) })
	cancel()
	if after.Facts.AgentID == "" {
		after.Facts.AgentID = before.Facts.AgentID
	}
	if before.Facts.AgentID != "" && after.Facts.AgentID == before.Facts.AgentID &&
		(after.Facts.AgentName == "" || after.Facts.AgentName == after.Facts.AgentID) {
		after.Facts.AgentName = before.Facts.AgentName
		if after.Summary != nil && after.Facts.AgentName != "" {
			after.Summary.Name = after.Facts.AgentName
		}
	}
	if after.Facts.RequiredVersion == "" {
		after.Facts.RequiredVersion = before.Facts.RequiredVersion
	}
	if after.Summary != nil && before.Facts.AgentID != "" && after.Summary.AgentID != before.Facts.AgentID {
		after = outcome("blocked", "management_identity_mismatch", after.Facts)
	}
	// A non-zero/uncertain return must not replay the operation.
	if after.Stage == "unknown" || after.Stage == "blocked" || after.Stage == "network" {
		c.publish(s, outcome("unknown", "start_outcome_unknown", after.Facts))
		c.endMutation(s)
		return
	}
	if after.Stage == "start" {
		after = outcome("connecting", "waiting_for_management", after.Facts)
	}
	c.publish(s, after)
	c.endMutation(s)
	c.observe(s, after, true)
}
func (c *Controller) observe(s *session, initial Outcome, started bool) {
	if !oneOf(initial.Stage, "ready", "connecting", "upgrade") {
		return
	}
	c.mu.Lock()
	if !c.validLocked(s) || c.mutation != nil {
		c.mu.Unlock()
		return
	}
	s.observation++
	generation := s.observation
	c.mu.Unlock()
	go c.observeCloud(s, generation)
	last := initial
	expected := initial.Facts.AgentID
	if expected == "" && initial.Summary != nil {
		expected = initial.Summary.AgentID
	}
	// Preserve only observations from the same target/session and same checked
	// binary. A changed version is re-inspected, never relabeled from cache.
	deadline := time.Now().Add(90 * time.Second)
	upgradeWindow := initial.Stage == "upgrade"
	if upgradeWindow {
		deadline = time.Now().Add(10 * time.Minute)
	}
	progressSupported := true
	for {
		if last.Stage != "ready" && time.Now().After(deadline) {
			c.publishObservation(s, generation, outcome("unknown", "observation_timeout", last.Facts))
			return
		}
		t := time.NewTimer(2 * time.Second)
		select {
		case <-s.ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(s.ctx, 45*time.Second)
		o := probe(ctx, s.rt, c.profile, c.origin, "observe", nil, &progressSupported)
		if o.Facts.Program == "present" && o.Facts.Version != last.Facts.Version {
			progressSupported = true
			o = probe(ctx, s.rt, c.profile, c.origin, "inspect", nil, &progressSupported)
		}
		cancel()
		// Keep the authenticated identity/name and version policy while observing
		// the same installation; do not manufacture new Cloud facts.
		if o.Facts.Version == last.Facts.Version && o.Facts.Program == "present" {
			if o.Facts.AgentID == "" {
				o.Facts.AgentID = last.Facts.AgentID
			}
			// A local observation may return Agent ID as a fallback name.
			// Preserve the Cloud-verified name for this same authenticated Agent.
			if (o.Facts.AgentName == "" || o.Facts.AgentName == o.Facts.AgentID) && (o.Facts.AgentID == last.Facts.AgentID || o.Facts.AgentID == expected) {
				o.Facts.AgentName = last.Facts.AgentName
			}
			if o.Facts.RequiredVersion == "" {
				o.Facts.RequiredVersion = last.Facts.RequiredVersion
			}
			if o.Summary != nil && o.Facts.AgentName != "" {
				o.Summary.Name = o.Facts.AgentName
			}
			if o.Stage == "ready" && o.Facts.RequiredVersion != "" && o.Summary.Version != o.Facts.RequiredVersion {
				o = outcome("upgrade", "version_incompatible", o.Facts)
			}
		}
		if o.Facts.AgentID != "" && expected != "" && o.Facts.AgentID != expected || o.Summary != nil && expected != "" && o.Summary.AgentID != expected {
			c.publishObservation(s, generation, outcome("blocked", "management_identity_mismatch", o.Facts))
			return
		}
		if o.Stage == "ready" {
			if last.Reason == "maintenance_busy" && last.Summary != nil && o.Summary != nil &&
				last.Summary.AgentID == o.Summary.AgentID && last.Summary.BootID == o.Summary.BootID {
				o.Reason = "maintenance_busy"
			}
			c.mu.Lock()
			priorBoot := s.maintenanceBoot
			c.mu.Unlock()
			if priorBoot != "" && o.Summary.BootID == priorBoot {
				c.publishObservation(s, generation, outcome("blocked", "management_identity_mismatch", o.Facts))
				return
			}
			if priorBoot != "" {
				c.mu.Lock()
				if c.validLocked(s) && s.observation == generation {
					s.maintenanceBoot = ""
				}
				c.mu.Unlock()
			}
			if last.Stage != "ready" {
				deadline = time.Now().Add(90 * time.Second)
			}
			if expected == "" {
				expected = o.Summary.AgentID
			}
			if last.Facts.RequiredVersion != "" && o.Facts.Version == last.Facts.Version && o.Facts.RequiredVersion == "" {
				o.Facts.RequiredVersion = last.Facts.RequiredVersion
				if o.Facts.Version != o.Facts.RequiredVersion {
					o = outcome("upgrade", "version_incompatible", o.Facts)
				}
			}
			upgradeWindow = false
		} else if last.Stage == "ready" {
			deadline = time.Now().Add(90 * time.Second)
			upgradeWindow = false
		}
		// A verified upgrade may include a multi-minute download. Do not renew
		// the deadline for every progress update or reconnect within this upgrade.
		if o.Stage == "upgrade" && !upgradeWindow {
			deadline = time.Now().Add(10 * time.Minute)
			upgradeWindow = true
		}
		if started && (o.Stage == "start" || o.Stage == "network") {
			o = outcome("connecting", "waiting_for_management", o.Facts)
		}
		// The supervisor can briefly report an unknown service after accepting
		// a start. Observe the same target until its identity is confirmed;
		// never retry the mutation or treat this as readiness.
		if started && o.Stage == "unknown" && o.Reason == "service_identity_unconfirmed" && o.Facts.Service == "unknown" {
			o = outcome("connecting", "waiting_for_management", o.Facts)
		}
		if oneOf(o.Stage, "network", "unknown") && oneOf(last.Stage, "ready", "connecting", "upgrade") && s.rt.Alive() && oneOf(o.Reason, "credential_unconfirmed", "operation_outcome_unknown", "waiting_for_management") {
			o = outcome("connecting", "waiting_for_management", o.Facts)
		}
		if !c.publishObservation(s, generation, o) {
			return
		}
		last = o
		if !oneOf(o.Stage, "ready", "connecting", "upgrade") {
			return
		}
	}
}

// Leaving a target invalidates read-only results and cancels only an unconsumed authorization.
// Once a mutation was admitted, let it resolve against its original target; no new mutation can overlap it.
func (c *Controller) Leave(id, operation string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.current
	if s == nil || s.id != id || s.operation != operation {
		return
	}
	if c.mutation == s {
		if oneOf(s.state.Stage, "authorizing", "waiting") && s.authorizationCancel != nil {
			s.authorizationCancel()
		}
		return
	}
	s.cancel()
	c.current = nil
}
func (c *Controller) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.current != nil {
		c.current.cancel()
	}
}
