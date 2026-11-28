package main

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

type MaterialNoticeItem struct {
	lifecycle.MaterialItem
	Notice            string `json:"notice,omitempty"`
	InstalledRevision string `json:"installedRevision,omitempty"`
	AvailableRevision string `json:"availableRevision,omitempty"`
	UpdateCheck       string `json:"updateCheck,omitempty"`
}

type MaterialOverview struct {
	TargetID    string               `json:"targetId"`
	OperationID string               `json:"operationId"`
	AgentID     string               `json:"agentId"`
	BootID      string               `json:"bootId"`
	State       string               `json:"state"`
	Items       []MaterialNoticeItem `json:"items"`
}

type materialMonitor struct {
	mu           sync.Mutex
	cancel       context.CancelFunc
	refresh      chan struct{}
	key          MaterialOverview
	current      MaterialOverview
	checkUpdates func(context.Context, []lifecycle.SkillEvidence) map[string]skillUpdate
}

type materialReader interface {
	OnlineMaterialsContext(context.Context, string, string, string, string, string, string, string) (lifecycle.WorkspaceSnapshot, error)
	SkillEvidence(context.Context, string, string, string, string, bool) ([]lifecycle.SkillEvidence, error)
	MaterialsOnline(string, string, string, string) bool
}

func (m *materialMonitor) snapshot() MaterialOverview {
	m.mu.Lock()
	defer m.mu.Unlock()
	value := m.current
	value.Items = append([]MaterialNoticeItem{}, value.Items...)
	return value
}

func (m *materialMonitor) publish(ctx context.Context, value MaterialOverview) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ctx.Err() == nil {
		value.Items = append([]MaterialNoticeItem{}, value.Items...)
		m.current = value
	}
}

func (m *materialMonitor) requestRefresh() {
	select {
	case m.refresh <- struct{}{}:
	default:
	}
}

func (m *materialMonitor) run(ctx context.Context, controller materialReader) {
	identity := m.key
	updates := map[string]skillUpdate{}
	revisions := map[string]string{}
	var nextUpdate time.Time
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.refresh:
		case <-timer.C:
		}
		started := time.Now()
		roundCtx, finishRound := context.WithTimeout(ctx, 55*time.Second)
		value := identity
		value.State = "unavailable"
		value.Items = []MaterialNoticeItem{}
		view, err := controller.OnlineMaterialsContext(roundCtx, identity.TargetID, identity.OperationID, identity.AgentID, identity.BootID, "", "", "")
		if err == nil && view.Materials != nil && view.Materials.List != nil {
			value.State = "available"
			if !view.Materials.List.Complete {
				value.State = "partial"
			}
			for _, item := range view.Materials.List.Items {
				notice := MaterialNoticeItem{MaterialItem: item}
				if item.Kind == "skill" && item.Source == "personal" {
					notice.UpdateCheck = "unknown"
				}
				if item.Problem != "" {
					notice.Notice = "danger"
				} else if previous, ok := updates[item.ID]; ok && revisions[item.ID] == item.Revision {
					notice.Notice, notice.InstalledRevision, notice.AvailableRevision = previous.notice, previous.installed, previous.available
					if previous.checked {
						notice.UpdateCheck = "checked"
					}
				}
				value.Items = append(value.Items, notice)
			}
			missing, missingErr := controller.SkillEvidence(roundCtx, identity.TargetID, identity.OperationID, identity.AgentID, identity.BootID, true)
			if missingErr == nil {
				seen := make(map[string]bool, len(value.Items))
				for _, item := range value.Items {
					seen[item.ID] = true
				}
				for _, item := range missing {
					if seen[item.ID] {
						continue
					}
					if len(value.Items) >= 200 {
						value.State = "partial"
						break
					}
					value.Items = append(value.Items, MaterialNoticeItem{
						MaterialItem: lifecycle.MaterialItem{ID: item.ID, Kind: "skill", Name: item.Name, Source: "personal", Problem: item.Problem},
						Notice:       "danger",
					})
				}
			} else {
				value.State = "partial"
			}
		}
		m.publish(ctx, value)
		if err == nil && view.Materials != nil && view.Materials.List != nil && roundCtx.Err() == nil && time.Now().After(nextUpdate) {
			nextUpdate = time.Now().Add(6 * time.Hour)
			updates = map[string]skillUpdate{}
			revisions = map[string]string{}
			for i := range value.Items {
				item := &value.Items[i]
				if item.Problem == "" {
					item.Notice, item.InstalledRevision, item.AvailableRevision = "", "", ""
					if item.Kind == "skill" && item.Source == "personal" {
						item.UpdateCheck = "unknown"
					}
				}
			}
			m.publish(ctx, value)
			evidence, evidenceErr := controller.SkillEvidence(roundCtx, identity.TargetID, identity.OperationID, identity.AgentID, identity.BootID, false)
			if evidenceErr == nil && roundCtx.Err() == nil && len(evidence) > 0 {
				checkCtx, cancel := context.WithTimeout(roundCtx, 45*time.Second)
				check := m.checkUpdates
				if check == nil {
					check = checkSkillUpdates
				}
				updates = check(checkCtx, evidence)
				cancel()
				for _, item := range value.Items {
					revisions[item.ID] = item.Revision
				}
				verified, verifyErr := controller.OnlineMaterialsContext(roundCtx, identity.TargetID, identity.OperationID, identity.AgentID, identity.BootID, "", "", "")
				same := verifyErr == nil && verified.Materials != nil && verified.Materials.List != nil &&
					reflect.DeepEqual(view.Materials.List, verified.Materials.List)
				if same && controller.MaterialsOnline(identity.TargetID, identity.OperationID, identity.AgentID, identity.BootID) {
					for i := range value.Items {
						item := &value.Items[i]
						if item.Problem == "" {
							if update, ok := updates[item.ID]; ok {
								item.Notice, item.InstalledRevision, item.AvailableRevision = update.notice, update.installed, update.available
								if update.checked {
									item.UpdateCheck = "checked"
								}
							}
						}
					}
					m.publish(ctx, value)
				} else if ctx.Err() == nil {
					updates = map[string]skillUpdate{}
					revisions = map[string]string{}
					if verifyErr == nil && verified.Materials != nil && verified.Materials.List != nil && !same {
						nextUpdate = time.Time{}
					}
					m.requestRefresh()
				}
			}
		}
		finishRound()
		timer.Reset(time.Until(started.Add(time.Minute)))
	}
}

func (s *FoundationService) GetAgentMaterialsOverview(targetID, operationID, agentID, bootID string) (MaterialOverview, error) {
	c, err := s.lifecycleController()
	if err != nil || !c.MaterialsOnline(targetID, operationID, agentID, bootID) {
		s.StopAgentMaterials(targetID, operationID, agentID, bootID)
		return MaterialOverview{}, errors.New("materials_unavailable")
	}
	s.materialsMu.Lock()
	defer s.materialsMu.Unlock()
	if !c.MaterialsOnline(targetID, operationID, agentID, bootID) {
		return MaterialOverview{}, errors.New("materials_unavailable")
	}
	m := s.materials
	if m == nil || m.key.TargetID != targetID || m.key.OperationID != operationID || m.key.AgentID != agentID || m.key.BootID != bootID {
		if m != nil {
			m.cancel()
		}
		ctx, cancel := context.WithCancel(context.Background())
		key := MaterialOverview{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
		m = &materialMonitor{cancel: cancel, refresh: make(chan struct{}, 1), key: key, current: key}
		m.current.State, m.current.Items = "loading", []MaterialNoticeItem{}
		s.materials = m
		go func() {
			s.materialsWorker.Lock()
			defer s.materialsWorker.Unlock()
			if ctx.Err() == nil {
				m.run(ctx, c)
			}
		}()
	}
	return m.snapshot(), nil
}

func (s *FoundationService) RefreshAgentMaterials(targetID, operationID, agentID, bootID string) error {
	c, err := s.lifecycleController()
	if err != nil || !c.MaterialsOnline(targetID, operationID, agentID, bootID) {
		return errors.New("materials_unavailable")
	}
	s.materialsMu.Lock()
	defer s.materialsMu.Unlock()
	if s.materials == nil || s.materials.key.TargetID != targetID || s.materials.key.OperationID != operationID ||
		s.materials.key.AgentID != agentID || s.materials.key.BootID != bootID {
		return errors.New("materials_unavailable")
	}
	s.materials.requestRefresh()
	return nil
}

func (s *FoundationService) stopMaterialsMonitor() {
	s.materialsMu.Lock()
	defer s.materialsMu.Unlock()
	if s.materials != nil {
		s.materials.cancel()
		s.materials = nil
	}
}

func (s *FoundationService) StopAgentMaterials(targetID, operationID, agentID, bootID string) {
	s.materialsMu.Lock()
	defer s.materialsMu.Unlock()
	m := s.materials
	if m != nil && m.key.TargetID == targetID && m.key.OperationID == operationID && m.key.AgentID == agentID && m.key.BootID == bootID {
		m.cancel()
		s.materials = nil
	}
}
