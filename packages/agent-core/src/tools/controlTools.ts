import { z } from 'zod'
import type { AgentTool } from '../types.ts'

const updateGoalSchema = z.object({
  progress: z.string().min(1),
  nextStep: z.string().optional(),
})

export const updateGoalTool: AgentTool = {
  name: 'update_goal',
  description: 'Record progress toward the current objective',
  risk: 'control',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['progress'],
    properties: {
      progress: { type: 'string' },
      nextStep: { type: 'string' },
    },
  },
  async execute(input) {
    const parsed = updateGoalSchema.parse(input)
    return {
      content: 'Goal progress updated',
      goalUpdate: parsed,
    }
  },
}

const finishSchema = z.object({
  status: z.enum(['completed', 'blocked']).default('completed'),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  remainingIssues: z.array(z.string()).default([]),
})

export const finishTool: AgentTool = {
  name: 'finish',
  description: 'Finish the objective with evidence or report a genuine blocker',
  risk: 'control',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      status: { enum: ['completed', 'blocked'] },
      summary: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      remainingIssues: { type: 'array', items: { type: 'string' } },
    },
  },
  async execute(input) {
    const parsed = finishSchema.parse(input)
    if (parsed.status === 'completed' && parsed.evidence.length === 0) {
      return { content: 'Cannot finish as completed without evidence' }
    }
    return {
      content: `Goal marked ${parsed.status}`,
      goalUpdate: {
        status: parsed.status,
        finalSummary: parsed.summary,
        evidence: parsed.evidence,
        remainingIssues: parsed.remainingIssues,
      },
    }
  },
}
