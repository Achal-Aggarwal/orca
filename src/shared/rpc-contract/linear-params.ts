import {
  RpcNull,
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString
} from './rpc-value-schemas'
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const VALID_CUSTOM_VIEW_MODELS = ['issue', 'project'] as const

export const LinearPriority = RpcNumber.int().min(0).max(4).optional()

export const LinearLabelIds = z.array(requiredString('Invalid label ID')).optional()

export const Connect = z.object({
  apiKey: requiredString('Invalid API key')
})

export const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

export const ConcreteWorkspaceId = requiredString(
  'Concrete Linear workspace ID is required'
).refine((value) => value !== 'all', 'Concrete Linear workspace ID is required')

export const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

export const SearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

export const CreateIssue = z.object({
  teamId: requiredString('Team ID is required'),
  title: requiredString('Title is required'),
  description: OptionalString,
  workspaceId: OptionalString,
  parentIssueId: OptionalString,
  projectId: z.union([RpcString, RpcNull]).optional(),
  stateId: OptionalString,
  priority: LinearPriority,
  assigneeId: z.union([RpcString, RpcNull]).optional(),
  labelIds: LinearLabelIds
})

export const IssueId = z.object({
  id: requiredString('Issue ID is required'),
  workspaceId: OptionalString
})

export const IssueComment = z.object({
  issueId: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  workspaceId: OptionalString
})

export const ListProjects = z
  .object({
    query: OptionalString,
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    force: RpcOptionalBoolean
  })
  .optional()

export const ProjectId = z.object({
  id: requiredString('Project ID is required'),
  workspaceId: ConcreteWorkspaceId,
  force: RpcOptionalBoolean
})

export const ProjectIssues = z.object({
  projectId: requiredString('Project ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId,
  force: RpcOptionalBoolean
})

export const ListCustomViews = z.object({
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString,
  force: RpcOptionalBoolean
})

export const CustomViewId = z.object({
  viewId: requiredString('Custom view ID is required'),
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  workspaceId: ConcreteWorkspaceId,
  force: RpcOptionalBoolean
})

export const CustomViewContents = z.object({
  viewId: requiredString('Custom view ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId,
  force: RpcOptionalBoolean
})

export const TeamId = z.object({
  teamId: requiredString('Team ID is required'),
  workspaceId: OptionalString
})

export const IssueUpdate = z.object({
  id: requiredString('Issue ID is required'),
  workspaceId: OptionalString,
  updates: z.object({
    stateId: OptionalString,
    title: OptionalString,
    description: RpcOptionalString,
    assigneeId: z.union([RpcString, RpcNull]).optional(),
    estimate: z.union([RpcNumber.int().min(0), RpcNull]).optional(),
    priority: RpcNumber.int().min(0).max(4).optional(),
    labelIds: z.array(RpcString).optional(),
    projectId: z.union([RpcString, RpcNull]).optional()
  })
})

export const LinearIssueCommentsParams = z.object({
  issueId: requiredString('Issue ID is required'),
  workspaceId: OptionalString
})
