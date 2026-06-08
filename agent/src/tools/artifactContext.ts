import type { AgentContext } from '@gsms/agent-core'

/**
 * Standard artifact metadata for matching-scope evidence.
 * Ensures all matching artifacts carry consistent context identifiers.
 */
export function matchingMetadata(context: AgentContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const state = context.domainState.snapshot()
  return {
    sceneId: typeof state.sceneId === 'string' ? state.sceneId : undefined,
    modelId: typeof state.modelId === 'string' ? state.modelId : undefined,
    matchingContextId: typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined,
    ...extra,
  }
}

/**
 * Standard artifact metadata for job-scope evidence.
 */
export function jobMetadata(context: AgentContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const state = context.domainState.snapshot()
  return {
    sceneId: typeof state.sceneId === 'string' ? state.sceneId : undefined,
    modelId: typeof state.modelId === 'string' ? state.modelId : undefined,
    jobId: typeof state.jobId === 'string' ? state.jobId : undefined,
    ...extra,
  }
}
