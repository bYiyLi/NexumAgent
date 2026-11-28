package main

import "github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"

func (s *FoundationService) GetAgentActivity(targetID, operationID, agentID, bootID, action, runID, cursor, kind string, offset int64) (lifecycle.ActivitySnapshot, error) {
	c, err := s.lifecycleController()
	if err != nil {
		return lifecycle.ActivitySnapshot{}, err
	}
	return c.Activity(targetID, operationID, agentID, bootID, action, runID, cursor, kind, offset)
}
