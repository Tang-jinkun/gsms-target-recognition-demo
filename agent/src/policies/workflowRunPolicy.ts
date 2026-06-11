import {
  isExecutionPhase,
  PERSISTED_EXECUTION_PHASES,
  STALE_EXECUTION_ARTIFACT_TYPES,
  WAITING_PHASES,
} from './workflowDefinition.ts'

export interface WorkflowRunStartTransitionInput {
  phase?: unknown
  previousSceneId?: string
  currentSceneId?: string
}

export interface WorkflowRunStartTransition {
  shouldReset: boolean
  statePatch?: Record<string, unknown>
  staleArtifactTypes: readonly string[]
  reason: string
}

export function workflowRunStartTransition(
  input: WorkflowRunStartTransitionInput,
): WorkflowRunStartTransition {
  const phase = typeof input.phase === 'string' ? input.phase : ''
  const shouldReset =
    !WAITING_PHASES.has(phase) &&
    (!isExecutionPhase(phase) || !PERSISTED_EXECUTION_PHASES.has(phase))

  if (!shouldReset) {
    return {
      shouldReset: false,
      staleArtifactTypes: [],
      reason: 'phase-persists-across-run-start',
    }
  }

  const sceneChanged = Boolean(
    input.previousSceneId &&
    input.currentSceneId &&
    input.previousSceneId !== input.currentSceneId,
  )
  return {
    shouldReset: true,
    statePatch: sceneChanged
      ? { phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null }
      : { phase: 'discovering-data' },
    staleArtifactTypes: STALE_EXECUTION_ARTIFACT_TYPES,
    reason: sceneChanged ? 'scene-changed' : 'fresh-workflow-run',
  }
}
