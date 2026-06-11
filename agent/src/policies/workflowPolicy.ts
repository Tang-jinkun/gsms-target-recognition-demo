import {
  phaseResumeInstruction,
} from './workflowResumePolicy.ts'
import {
  workflowEvidenceInstruction as buildWorkflowEvidenceInstruction,
  type WorkflowEvidenceInstructionInput,
} from './workflowEvidencePolicy.ts'

export * from './workflowDefinition.ts'
export * from './workflowResumePolicy.ts'
export * from './workflowRunPolicy.ts'
export * from './workflowTransitionPolicy.ts'
export type { WorkflowEvidenceInstructionInput } from './workflowEvidencePolicy.ts'

export function workflowEvidenceInstruction(input: WorkflowEvidenceInstructionInput): string {
  return buildWorkflowEvidenceInstruction({
    phaseResumeInstruction,
    ...input,
  })
}
