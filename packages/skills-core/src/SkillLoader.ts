import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type {
  SkillDefinition,
  SkillDiagnostic,
  SkillLoadResult,
  SkillSource,
} from './types.ts'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_DESCRIPTION_LENGTH = 1_000
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/

const frontmatterSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
    'allowed-tools': z.array(z.string().trim().min(1)).optional(),
    'user-invocable': z.boolean().default(true),
    'model-invocable': z.boolean().default(true),
    execution: z.enum(['inline', 'isolated']).default('inline'),
    version: z.string().trim().min(1).optional(),
  })
  .strict()

export interface SkillLoaderOptions {
  userSkillsDir?: string
  projectSkillsDir?: string
  builtinSkills?: readonly SkillDefinition[]
}

export class SkillLoader {
  readonly userSkillsDir: string
  readonly projectSkillsDir: string
  readonly builtinSkills: readonly SkillDefinition[]

  constructor(options: SkillLoaderOptions = {}) {
    this.userSkillsDir =
      options.userSkillsDir ?? join(homedir(), '.my-agent', 'skills')
    this.projectSkillsDir =
      options.projectSkillsDir ?? resolve('.my-agent', 'skills')
    this.builtinSkills = options.builtinSkills ?? []
  }

  get watchPaths(): string[] {
    return [this.userSkillsDir, this.projectSkillsDir]
  }

  async load(): Promise<SkillLoadResult> {
    const diagnostics: SkillDiagnostic[] = []
    const byName = new Map<string, SkillDefinition>()

    for (const skill of this.builtinSkills) byName.set(skill.name, skill)

    for (const [source, root] of [
      ['user', this.userSkillsDir],
      ['project', this.projectSkillsDir],
    ] as const) {
      const loaded = await this.#loadRoot(source, root)
      diagnostics.push(...loaded.diagnostics)
      for (const skill of loaded.skills) byName.set(skill.name, skill)
    }

    return { skills: [...byName.values()], diagnostics }
  }

  async #loadRoot(source: SkillSource, root: string): Promise<SkillLoadResult> {
    const skills: SkillDefinition[] = []
    const diagnostics: SkillDiagnostic[] = []
    let entries

    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return { skills, diagnostics }
      return {
        skills,
        diagnostics: [diagnostic(error, root)],
      }
    }

    for (const entry of entries) {
      const skillDir = join(root, entry.name)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) {
          diagnostics.push({
            severity: 'error',
            message: 'Symbolic-link skill directories are not allowed',
            path: skillDir,
          })
        }
        continue
      }

      try {
        skills.push(await loadSkillFile(source, root, skillDir))
      } catch (error) {
        diagnostics.push(diagnostic(error, join(skillDir, 'SKILL.md')))
      }
    }

    return { skills, diagnostics }
  }
}

async function loadSkillFile(
  source: SkillSource,
  root: string,
  skillDir: string,
): Promise<SkillDefinition> {
  const filePath = join(skillDir, 'SKILL.md')
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error('SKILL.md must be a regular file, not a symbolic link')
  }

  await assertContained(root, skillDir)
  await assertContained(skillDir, filePath)

  const markdown = await readFile(filePath, 'utf8')
  const match = markdown.match(FRONTMATTER_PATTERN)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')

  const raw = parseYaml(match[1] ?? '')
  const parsed = frontmatterSchema.parse(raw)
  const directoryName = basename(skillDir)
  if (parsed.name !== directoryName) {
    throw new Error(
      `Skill name "${parsed.name}" must match directory "${directoryName}"`,
    )
  }

  return {
    name: parsed.name,
    description: parsed.description,
    instructions: markdown.slice(match[0].length).trim(),
    source,
    allowedTools: parsed['allowed-tools'],
    userInvocable: parsed['user-invocable'],
    modelInvocable: parsed['model-invocable'],
    execution: parsed.execution,
    version: parsed.version,
    rootDir: skillDir,
    filePath,
  }
}

async function assertContained(parent: string, child: string): Promise<void> {
  const [realParent, realChild] = await Promise.all([realpath(parent), realpath(child)])
  const rel = relative(realParent, realChild)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return
  }
  throw new Error(`Path escapes allowed directory: ${child}`)
}

function diagnostic(error: unknown, path?: string): SkillDiagnostic {
  const message =
    error instanceof z.ZodError
      ? `Invalid frontmatter: ${error.issues
          .map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          .join('; ')}`
      : error instanceof Error
        ? error.message
        : String(error)
  return { severity: 'error', message, path }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
