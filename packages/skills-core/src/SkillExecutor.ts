import { SkillError } from './errors.ts'
import { createHash } from 'node:crypto'
import type {
  InvocationKind,
  SkillDefinition,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillInvocationRecord,
} from './types.ts'

export class SkillExecutor {
  readonly #approvedProjectSkills = new Set<string>()

  async execute(
    skill: SkillDefinition,
    args: string,
    invocation: InvocationKind,
    context: SkillExecutionContext,
  ): Promise<SkillExecutionResult> {
    const activeSkills = context.activeSkills ?? new Set<string>()
    if (activeSkills.has(skill.name)) {
      throw new SkillError(
        `Skill "${skill.name}" is already running`,
        'RECURSIVE_INVOCATION',
      )
    }

    const tools = narrowTools(context.availableTools, skill.allowedTools)
    let authorization: SkillInvocationRecord['authorization'] = 'not-required'
    let outcome: SkillInvocationRecord['outcome'] = 'error'

    if (skill.source === 'project' && !this.#approvedProjectSkills.has(identity(skill))) {
      const approved = await context.authorizeProjectSkill?.(skill)
      authorization = approved ? 'approved' : 'denied'
      if (!approved) {
        outcome = 'denied'
        context.onInvocation?.(record(skill, invocation, authorization, tools, outcome))
        throw new SkillError(
          `Project skill "${skill.name}" was not authorized`,
          'AUTHORIZATION_DENIED',
        )
      }
      this.#approvedProjectSkills.add(identity(skill))
    } else if (skill.source === 'project') {
      authorization = 'approved'
    }

    activeSkills.add(skill.name)
    try {
      const instructions = substituteArgs(skill.instructions, args)
      let result: SkillExecutionResult
      if (skill.execution === 'isolated') {
        if (!context.runIsolated) {
          throw new SkillError(
            `Skill "${skill.name}" requires an isolated runner`,
            'ISOLATED_RUNNER_REQUIRED',
          )
        }
        result = {
          type: 'isolated',
          skill: skill.name,
          result: await context.runIsolated({
            skill,
            instructions,
            allowedTools: tools,
          }),
          allowedTools: tools,
        }
      } else {
        result = {
          type: 'inline',
          skill: skill.name,
          message: { role: 'user', content: instructions },
          allowedTools: tools,
        }
      }
      outcome = 'success'
      return result
    } finally {
      activeSkills.delete(skill.name)
      context.onInvocation?.(record(skill, invocation, authorization, tools, outcome))
    }
  }
}

function narrowTools(
  availableTools: readonly string[],
  requestedTools?: readonly string[],
): string[] {
  if (!requestedTools) return [...new Set(availableTools)]
  const requested = new Set(requestedTools)
  return [...new Set(availableTools)].filter(tool => requested.has(tool))
}

function substituteArgs(instructions: string, args: string): string {
  return instructions.replaceAll('{{args}}', () => args)
}

function identity(skill: SkillDefinition): string {
  const contentHash = createHash('sha256')
    .update(skill.instructions)
    .digest('hex')
  return `${skill.filePath ?? skill.name}:${skill.version ?? ''}:${contentHash}`
}

function record(
  skill: SkillDefinition,
  invocation: InvocationKind,
  authorization: SkillInvocationRecord['authorization'],
  tools: string[],
  outcome: SkillInvocationRecord['outcome'],
): SkillInvocationRecord {
  return {
    skill: skill.name,
    source: skill.source,
    version: skill.version,
    invocation,
    execution: skill.execution,
    authorization,
    tools,
    timestamp: new Date().toISOString(),
    outcome,
  }
}
