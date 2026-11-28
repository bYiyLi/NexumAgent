package lifecycle

import (
	"context"
	"errors"
)

// MaterialsOnline gates Desktop materials operations on a Cloud-connected Agent.
func (c *Controller) MaterialsOnline(id, operation, agentID, bootID string) bool {
	return c.materialsOnline(id, operation, agentID, bootID)
}

func (c *Controller) OnlineMaterialsContext(ctx context.Context, id, operation, agentID, bootID, kind, resourceID, member string) (WorkspaceSnapshot, error) {
	if !c.MaterialsOnline(id, operation, agentID, bootID) {
		return WorkspaceSnapshot{}, errors.New("materials_unavailable")
	}
	view, err := c.MaterialsContext(ctx, id, operation, agentID, bootID, kind, resourceID, member)
	if err != nil || !c.MaterialsOnline(id, operation, agentID, bootID) {
		return WorkspaceSnapshot{}, errors.New("materials_unavailable")
	}
	return view, nil
}
