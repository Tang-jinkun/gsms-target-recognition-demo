import type { SkillDefinition, SkillSummary } from './types.ts'

const DEFAULT_DESCRIPTION_BUDGET = 8_000
const MIN_DESCRIPTION_CHARS = 24

export class SkillRegistry {
  readonly #skills = new Map<string, SkillDefinition>()

  replace(skills: readonly SkillDefinition[]): void {
    const next = new Map<string, SkillDefinition>()
    for (const skill of skills) next.set(skill.name, skill)
    this.#skills.clear()
    for (const [name, skill] of next) this.#skills.set(name, skill)
  }

  resolve(name: string): SkillDefinition | undefined {
    return this.#skills.get(normalizeName(name))
  }

  listForModel(): SkillSummary[] {
    return this.#list(skill => skill.modelInvocable)
  }

  listForUser(): SkillSummary[] {
    return this.#list(skill => skill.userInvocable)
  }

  formatForModel(charBudget = DEFAULT_DESCRIPTION_BUDGET): string {
    const skills = this.listForModel()
    if (skills.length === 0 || charBudget <= 0) return ''

    const overhead = skills.reduce(
      (total, skill) => total + skill.name.length + 4,
      Math.max(0, skills.length - 1),
    )
    const perDescription = Math.max(
      MIN_DESCRIPTION_CHARS,
      Math.floor((charBudget - overhead) / skills.length),
    )

    return skills
      .map(skill => {
        const base = `- ${skill.name}: ${truncate(skill.description, perDescription)}`
        if (skill.whenToUse) return `${base} — ${truncate(skill.whenToUse, perDescription)}`
        return base
      })
      .join('\n')
      .slice(0, charBudget)
  }

  #list(predicate: (skill: SkillDefinition) => boolean): SkillSummary[] {
    return [...this.#skills.values()]
      .filter(predicate)
      .map(({ name, description, whenToUse, source, execution }) => ({
        name,
        description,
        whenToUse,
        source,
        execution,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return value.slice(0, max)
  return `${value.slice(0, max - 1)}…`
}
