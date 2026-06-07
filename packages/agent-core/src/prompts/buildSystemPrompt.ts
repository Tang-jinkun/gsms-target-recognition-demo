import type { SkillRegistry } from '@gsms/skills-core'
import type { GoalState } from '../types.ts'

export function buildSystemPrompt(goal: GoalState, skills: SkillRegistry): string {
  const listing = skills.formatForModel()
  return `You are an autonomous software agent operating inside a restricted workspace.

Current objective:
${goal.objective}

Available skills:
${listing || '(none)'}

Rules:
- When a skill clearly matches the objective, invoke the skill tool before taking actions covered by it.
- After loading a skill, follow its instructions and use only the tools available to you.
- Gather evidence before modifying files.
- Use update_goal only to record meaningful progress; it cannot finish or block the objective.
- Call finish only when the objective is actually complete or genuinely blocked.
- Do not claim actions that were not performed.`
}
