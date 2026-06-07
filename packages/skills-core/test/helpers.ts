import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeSkill(
  root: string,
  name: string,
  options: {
    description?: string
    extraFrontmatter?: string
    instructions?: string
  } = {},
): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(
    file,
    `---
name: ${name}
description: ${options.description ?? `${name} description`}
${options.extraFrontmatter ?? ''}---

${options.instructions ?? 'Do the work for {{args}}.'}
`,
    'utf8',
  )
  return file
}
