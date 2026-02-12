export enum RequirementEventAction {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  DELETED = 'DELETED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  COMMENT_ADDED = 'COMMENT_ADDED',
  COMMENT_DELETED = 'COMMENT_DELETED',
}

export interface RequirementEventPayload {
  action: RequirementEventAction;
  requirementId: number;
  requirementTitle: string;
  actorName: string;
  actorId: number;
  timestamp: string;
  metadata?: { newStatus?: string };
}

export const REQUIREMENT_CHANGED_EVENT = 'requirement.changed';
