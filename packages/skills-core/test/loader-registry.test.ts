import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillLoader, SkillRegistry } from '../src/index.ts'
import { writeSkill } from './helpers.ts'

test('loads skills and lets project skills override user skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-loader-'))
  const user = join(root, 'user')
  const project = join(root, 'project')
  await writeSkill(user, 'review', { description: 'user review' })
  await writeSkill(project, 'review', { description: 'project review' })
  await writeSkill(user, 'deploy', {
    extraFrontmatter: 'model-invocable: false\n',
  })
  await writeSkill(user, 'match-data', {
    extraFrontmatter: [
      'when_to_use: Match scene data to model inputs',
      'intent_tags:',
      '  - match-inputs',
      'trigger_examples:',
      '  - 帮我匹配 Carbon 模型输入',
      'allowed_tools:',
      '  - list_scene_data_cards',
      '',
    ].join('\n'),
  })

  const result = await new SkillLoader({
    userSkillsDir: user,
    projectSkillsDir: project,
  }).load()

  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.skills.length, 3)
  assert.equal(
    result.skills.find(skill => skill.name === 'review')?.description,
    'project review',
  )
  const matchData = result.skills.find(skill => skill.name === 'match-data')
  assert.equal(matchData?.whenToUse, 'Match scene data to model inputs')
  assert.deepEqual(matchData?.intentTags, ['match-inputs'])
  assert.deepEqual(matchData?.triggerExamples, ['帮我匹配 Carbon 模型输入'])
  assert.deepEqual(matchData?.allowedTools, ['list_scene_data_cards'])
})

test('strictly validates frontmatter and directory names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-invalid-'))
  const user = join(root, 'user')
  await writeSkill(user, 'bad-name', { extraFrontmatter: 'unknown: value\n' })
  await mkdir(join(user, 'mismatch'), { recursive: true })
  await writeFile(
    join(user, 'mismatch', 'SKILL.md'),
    '---\nname: other\ndescription: mismatch\n---\nText',
  )
  await writeSkill(user, 'too-long', { description: 'x'.repeat(1_001) })

  const result = await new SkillLoader({
    userSkillsDir: user,
    projectSkillsDir: join(root, 'missing'),
  }).load()

  assert.equal(result.skills.length, 0)
  assert.equal(result.diagnostics.length, 3)
  assert.ok(result.diagnostics.every(item => item.severity === 'error'))
})

test('registry exposes summaries within budget, not instructions', () => {
  const registry = new SkillRegistry()
  registry.replace([
    {
      name: 'review',
      description: 'A detailed description that should be shortened for discovery',
      instructions: 'SECRET FULL INSTRUCTIONS',
      source: 'user',
      userInvocable: true,
      modelInvocable: true,
      execution: 'inline',
    },
    {
      name: 'manual',
      description: 'User only',
      instructions: 'Manual',
      source: 'user',
      userInvocable: true,
      modelInvocable: false,
      execution: 'inline',
    },
  ])

  const listing = registry.formatForModel(45)
  assert.ok(listing.length <= 45)
  assert.match(listing, /review/)
  assert.doesNotMatch(listing, /SECRET/)
  assert.deepEqual(registry.listForModel().map(skill => skill.name), ['review'])
  assert.deepEqual(registry.listForUser().map(skill => skill.name), [
    'manual',
    'review',
  ])
})
