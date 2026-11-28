package main

import (
	"github.com/bYiyLi/NexumAgent/desktop/internal/capabilitywatch"
	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

func (s *FoundationService) GetAgentCapabilities(targetID, operationID, agentID, bootID string) (lifecycle.CapabilityInventory, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.CapabilityInventory{}, err
	}
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	ctx, err := s.capabilityQueryContext(scope)
	if err != nil {
		return lifecycle.CapabilityInventory{}, err
	}
	s.capabilityQueryMu.Lock()
	defer s.capabilityQueryMu.Unlock()
	return c.CapabilitiesContext(ctx, targetID, operationID, agentID, bootID)
}

func (s *FoundationService) GetAgentCapabilityDetail(targetID, operationID, agentID, bootID, resourceID string) (lifecycle.CapabilityDetailSnapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.CapabilityDetailSnapshot{}, err
	}
	scope := capabilitywatch.Scope{TargetID: targetID, OperationID: operationID, AgentID: agentID, BootID: bootID}
	ctx, err := s.capabilityQueryContext(scope)
	if err != nil {
		return lifecycle.CapabilityDetailSnapshot{}, err
	}
	s.capabilityQueryMu.Lock()
	defer s.capabilityQueryMu.Unlock()
	return c.CapabilityDetailContext(ctx, targetID, operationID, agentID, bootID, resourceID)
}
