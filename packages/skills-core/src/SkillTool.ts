import { SkillError } from './errors.ts'
import { SkillExecutor } from './SkillExecutor.ts'
import { SkillRegistry } from './SkillRegistry.ts'
import type {
  SkillExecutionContext,
  SkillExecutionResult,
  SkillToolInput,
} from './types.ts'

export class SkillTool {
  constructor(
    readonly registry: SkillRegistry,
    readonly executor = new SkillExecutor(),
  ) {}

  async invokeModel(
    input: SkillToolInput,
    context: SkillExecutionContext,
  ): Promise<SkillExecutionResult> {
    return this.#invoke(input, context, 'model')
  }

  async invokeUser(
    input: SkillToolInput,
    context: SkillExecutionContext,
  ): Promise<SkillExecutionResult> {
    return this.#invoke(input, context, 'user')
  }

  asModelTool(context: SkillExecutionContext) {
    return {
      name: 'skill',
      description: 'Load and execute an available skill by name',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['skill'],
        properties: {
          skill: { type: 'string', description: 'Skill name' },
          args: { type: 'string', description: 'Optional literal arguments' },
        },
      },
      execute: (input: SkillToolInput) => this.invokeModel(input, context),
    } as const
  }

  async #invoke(
    input: SkillToolInput,
    context: SkillExecutionContext,
    invocation: 'model' | 'user',
  ): Promise<SkillExecutionResult> {
    const name = input.skill.trim().replace(/^\/+/, '')
    const skill = this.registry.resolve(name)
    if (!skill) throw new SkillError(`Unknown skill: ${name}`, 'UNKNOWN_SKILL')

    const invocable =
      invocation === 'model' ? skill.modelInvocable : skill.userInvocable
    if (!invocable) {
      throw new SkillError(
        `Skill "${name}" cannot be invoked by ${invocation}`,
        'NOT_INVOCABLE',
      )
    }

    return this.executor.execute(skill, input.args ?? '', invocation, context)
  }
}
