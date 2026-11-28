package main

import (
	"context"
	"errors"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

func (s *FoundationService) GetAgentMaterials(targetID, operationID, agentID, bootID, kind, resourceID, member string) (lifecycle.WorkspaceSnapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.WorkspaceSnapshot{}, err
	}
	return c.OnlineMaterialsContext(context.Background(), targetID, operationID, agentID, bootID, kind, resourceID, member)
}

func (s *FoundationService) PrepareMaterialRemoval(targetID, operationID, agentID, bootID, kind, resourceID string) (lifecycle.MaterialRemoval, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.MaterialRemoval{}, err
	}
	return c.RemoveMaterial(targetID, operationID, agentID, bootID, "prepare", kind, resourceID, "")
}

func (s *FoundationService) ConfirmMaterialRemoval(targetID, operationID, agentID, bootID, kind, resourceID, token string) (lifecycle.MaterialRemoval, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.MaterialRemoval{}, err
	}
	result, err := c.RemoveMaterial(targetID, operationID, agentID, bootID, "commit", kind, resourceID, token)
	if refreshErr := s.RefreshAgentMaterials(targetID, operationID, agentID, bootID); refreshErr != nil && err == nil {
		return result, nil
	}
	return result, err
}

func (s *FoundationService) GetAgentTelemetry(targetID, operationID, agentID, bootID string) (lifecycle.WorkspaceSnapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.WorkspaceSnapshot{}, err
	}
	return c.Telemetry(targetID, operationID, agentID, bootID)
}

func (s *FoundationService) GetAgentSystemEvents(targetID, operationID, agentID, bootID string) (lifecycle.WorkspaceSnapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.WorkspaceSnapshot{}, err
	}
	return c.SystemEvents(targetID, operationID, agentID, bootID)
}

func (s *FoundationService) OpenCloudAgent(targetID, operationID, agentID, bootID string) error {
	c, err := s.lifecycleController()
	if err != nil {
		return err
	}
	url, err := c.CloudAgentURL(targetID, operationID, agentID, bootID)
	if err != nil {
		return err
	}
	if s.openAgentBrowser == nil {
		return errors.New("browser unavailable")
	}
	return s.openAgentBrowser(url)
}
