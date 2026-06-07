import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillLoader, SkillRegistry, SkillWatcher } from '../src/index.ts'
import { writeSkill } from './helpers.ts'

test('reload preserves the last valid registry when parsing fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-watcher-'))
  const user = join(root, 'user')
  const file = await writeSkill(user, 'review', { description: 'valid' })
  const registry = new SkillRegistry()
  const diagnostics: string[] = []
  const watcher = new SkillWatcher(
    new SkillLoader({
      userSkillsDir: user,
      projectSkillsDir: join(root, 'missing'),
    }),
    registry,
    { onDiagnostics: items => diagnostics.push(...items.map(item => item.message)) },
  )

  assert.equal(await watcher.reloadNow(), true)
  assert.equal(registry.resolve('review')?.description, 'valid')

  await writeFile(file, '---\nname: review\nunknown: true\n---\nBroken')
  assert.equal(await watcher.reloadNow(), false)
  assert.equal(registry.resolve('review')?.description, 'valid')
  assert.ok(diagnostics.some(message => message.includes('Invalid frontmatter')))
})
