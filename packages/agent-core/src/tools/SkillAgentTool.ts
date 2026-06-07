import {
  SkillTool,
  type SkillDefinition,
  type SkillExecutionContext,
  type SkillInvocationRecord,
} from '@gsms/skills-core'
import type { AgentMessage, AgentTool } from '../types.ts'

export interface SkillAgentToolOptions {
  availableTools: () => readonly string[]
  authorizeProjectSkill?: (skill: SkillDefinition) => boolean | Promise<boolean>
  runIsolated?: SkillExecutionContext['runIsolated']
  onInvocation?: (record: SkillInvocationRecord) => void
}

export function createSkillAgentTool(
  skillTool: SkillTool,
  options: SkillAgentToolOptions,
): AgentTool {
  return {
    name: 'skill',
    description: 'Load a relevant skill before acting on specialized tasks',
    risk: 'control',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill'],
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
    },
    async execute(input, context) {
      const parsed = input as { skill: string; args?: string }
      if (context.skillScope?.name === parsed.skill.replace(/^\/+/, '')) {
        return {
          content:
            `Skill "${context.skillScope.name}" is already active; continue using the existing skill instructions.`,
          hiddenMessages: [{
            role: 'user',
            content:
              `[Active skill reminder: ${context.skillScope.name}]\n\n` +
              'The requested skill is already active. Do not call the skill tool again for this same skill; continue with the next required domain tool.',
            hidden: true,
          } satisfies AgentMessage],
        }
      }
      const result = await skillTool.invokeModel(parsed, {
        availableTools: options.availableTools(),
        authorizeProjectSkill: options.authorizeProjectSkill,
        runIsolated: options.runIsolated,
        onInvocation: options.onInvocation,
      })
      if (result.type === 'isolated') {
        return { content: result.result }
      }
      return {
        content: `Skill "${result.skill}" loaded`,
        hiddenMessages: [
          {
            role: 'user',
            content: `[Active skill: ${result.skill}]\n\n${result.message.content}`,
            hidden: true,
          },
        ],
        activateSkill: { name: result.skill, allowedTools: result.allowedTools },
      }
    },
  }
}
