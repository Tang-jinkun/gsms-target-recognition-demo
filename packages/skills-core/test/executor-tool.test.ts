import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SkillError,
  SkillExecutor,
  SkillRegistry,
  SkillTool,
  type SkillDefinition,
  type SkillInvocationRecord,
} from '../src/index.ts'

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'review',
    description: 'Review changes',
    instructions: 'Review {{args}}. Keep {{notExecutable}} unchanged.',
    source: 'project',
    allowedTools: ['read_file', 'dangerous_tool'],
    userInvocable: true,
    modelInvocable: true,
    execution: 'inline',
    filePath: '/project/review/SKILL.md',
    version: '1',
    ...overrides,
  }
}

test('authorizes project skill once and only narrows tool permissions', async () => {
  const registry = new SkillRegistry()
  registry.replace([skill()])
  const records: SkillInvocationRecord[] = []
  let authorizationCalls = 0
  const tool = new SkillTool(registry)
  const context = {
    availableTools: ['read_file', 'write_file'],
    authorizeProjectSkill: () => {
      authorizationCalls++
      return true
    },
    onInvocation: (record: SkillInvocationRecord) => records.push(record),
  }

  const first = await tool.invokeModel(
    { skill: '/review', args: '$& {{notExecutable}}' },
    context,
  )
  await tool.invokeModel({ skill: 'review' }, context)

  assert.equal(first.type, 'inline')
  if (first.type === 'inline') {
    assert.deepEqual(first.allowedTools, ['read_file'])
    assert.match(first.message.content, /\$& \{\{notExecutable\}\}/)
  }
  assert.equal(authorizationCalls, 1)
  assert.equal(records.length, 2)
  assert.equal(records[0]?.authorization, 'approved')
  assert.equal(records[0]?.outcome, 'success')
})

test('requires new authorization after project skill content changes', async () => {
  const executor = new SkillExecutor()
  let authorizationCalls = 0
  const context = {
    availableTools: [] as string[],
    authorizeProjectSkill: () => {
      authorizationCalls++
      return true
    },
  }

  await executor.execute(skill(), '', 'model', context)
  await executor.execute(
    skill({ instructions: 'Changed project instructions' }),
    '',
    'model',
    context,
  )

  assert.equal(authorizationCalls, 2)
})

test('enforces model and user invocation permissions', async () => {
  const registry = new SkillRegistry()
  registry.replace([skill({ source: 'user', modelInvocable: false })])
  const tool = new SkillTool(registry)

  await assert.rejects(
    tool.invokeModel({ skill: 'review' }, { availableTools: [] }),
    (error: unknown) =>
      error instanceof SkillError && error.code === 'NOT_INVOCABLE',
  )
  await tool.invokeUser({ skill: 'review' }, { availableTools: [] })
})

test('denies unauthorized project skills and records the decision', async () => {
  const records: SkillInvocationRecord[] = []
  const executor = new SkillExecutor()

  await assert.rejects(
    executor.execute(skill(), '', 'model', {
      availableTools: [],
      authorizeProjectSkill: () => false,
      onInvocation: record => records.push(record),
    }),
    (error: unknown) =>
      error instanceof SkillError && error.code === 'AUTHORIZATION_DENIED',
  )

  assert.equal(records[0]?.authorization, 'denied')
  assert.equal(records[0]?.outcome, 'denied')
})

test('runs isolated skills and blocks recursive invocation', async () => {
  const executor = new SkillExecutor()
  const isolated = skill({ source: 'user', execution: 'isolated' })
  const result = await executor.execute(isolated, 'PR 42', 'model', {
    availableTools: ['read_file'],
    runIsolated: ({ instructions, allowedTools }) =>
      `${instructions}|${allowedTools.join(',')}`,
  })

  assert.equal(result.type, 'isolated')
  if (result.type === 'isolated') {
    assert.match(result.result, /PR 42/)
    assert.match(result.result, /read_file/)
  }

  await assert.rejects(
    executor.execute(skill({ source: 'user' }), '', 'model', {
      availableTools: [],
      activeSkills: new Set(['review']),
    }),
    (error: unknown) =>
      error instanceof SkillError && error.code === 'RECURSIVE_INVOCATION',
  )
})

test('provides a provider-neutral model tool adapter', async () => {
  const registry = new SkillRegistry()
  registry.replace([skill({ source: 'user' })])
  const adapter = new SkillTool(registry).asModelTool({ availableTools: [] })

  assert.equal(adapter.name, 'skill')
  assert.deepEqual(adapter.inputSchema.required, ['skill'])
  const result = await adapter.execute({ skill: 'review' })
  assert.equal(result.type, 'inline')
})
