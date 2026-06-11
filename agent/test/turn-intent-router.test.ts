import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeModelAdapter } from '@gsms/agent-core'
import { routeTurnIntent, TurnIntentRouter } from '../src/index.ts'

test('turn intent router classifies plain questions without starting workflow', () => {
  assert.equal(routeTurnIntent({ userMessage: '1+1=?' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '你好' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '解释一下碳储量模型的概念' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '数据是什么？' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '请介绍机器学习模型。' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '什么是环境影响报告？' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '帮我写一份会议报告。' }).intent, 'ambiguous')
})

test('turn intent router keeps weak Chinese domain words out of deterministic workflow routing', () => {
  const generalQuestions = [
    '这个数据从哪里来？',
    '模型训练为什么会过拟合？',
    '请说明报告格式要求。',
    '场景描写怎么写得更自然？',
    'data 是什么意思？',
    'What is a model card?',
  ]

  for (const userMessage of generalQuestions) {
    const route = routeTurnIntent({ userMessage })
    assert.notEqual(route.intent, 'invest-workflow', userMessage)
    assert.notEqual(route.intent, 'workflow-continue', userMessage)
  }
})

test('turn intent router classifies explicit GSMS and InVEST work', () => {
  assert.equal(routeTurnIntent({ userMessage: '当前场景能跑哪些模型？' }).intent, 'invest-workflow')
  assert.equal(routeTurnIntent({ userMessage: '帮我匹配 Carbon 模型输入' }).intent, 'invest-workflow')
  const matchOnly = routeTurnIntent({ userMessage: '重新匹配 Carbon 数据，但不要执行。' })
  assert.equal(matchOnly.intent, 'invest-workflow')
  assert.equal(matchOnly.workflowAction, 'match-inputs')
})

test('turn intent router maps realistic Chinese workflow requests to actions', () => {
  const cases: Array<[string, string]> = [
    ['当前场景有哪些 InVEST 模型真正可运行？', 'assess-runnable-models'],
    ['重新匹配 Carbon 数据，但不要执行。', 'match-inputs'],
    ['验证刚才的 Carbon 绑定方案。', 'validate'],
    ['确认这个验证快照。', 'confirm'],
    ['执行已确认的验证快照。', 'execute'],
    ['看一下这次运行结果。', 'inspect-results'],
    ['给当前 InVEST 结果写报告。', 'write-report'],
  ]

  for (const [userMessage, action] of cases) {
    const route = routeTurnIntent({
      userMessage,
      domainState: { phase: 'ready-for-validation', modelId: 'carbon' },
      artifacts: [{ id: 'binding', type: 'binding-report' }],
    })
    assert.equal(route.intent === 'workflow-continue' || route.intent === 'invest-workflow', true, userMessage)
    assert.equal(route.workflowAction, action, userMessage)
  }
})

test('turn intent router can use skill trigger metadata without loading skill bodies', () => {
  const route = routeTurnIntent({
    userMessage: '请做候选绑定',
    skillSummaries: [{
      name: 'data-matching',
      description: 'Match scene assets',
      whenToUse: 'Use for candidate binding',
      intentTags: ['match-inputs'],
      triggerExamples: ['候选绑定'],
      source: 'builtin',
      execution: 'inline',
    }],
  })

  assert.equal(route.intent, 'invest-workflow')
  assert.equal(route.workflowAction, 'match-inputs')
  assert.deepEqual(route.exposeSkills, ['data-matching'])
})

test('turn intent router continues only when workflow state is continuable', () => {
  assert.equal(
    routeTurnIntent({
      userMessage: '验证刚才的方案',
      domainState: { phase: 'ready-for-validation', modelId: 'carbon' },
      artifacts: [{ type: 'binding-report', id: 'binding' }],
    }).intent,
    'workflow-continue',
  )
  assert.equal(routeTurnIntent({ userMessage: '继续' }).intent, 'ambiguous')
})

test('turn intent router uses classifier as a no-tool fallback', async () => {
  const classifier = new FakeModelAdapter([
    {
      content: JSON.stringify({
        intent: 'invest-workflow',
        confidence: 0.66,
        reason: 'classifier saw a project workflow request',
        workflowAction: 'match-inputs',
        modelId: 'carbon',
      }),
    },
  ])

  const plan = await new TurnIntentRouter({ classifierModel: classifier }).route({
    userMessage: '请处理一下这个配置',
  })

  assert.equal(plan.intent, 'invest-workflow')
  assert.equal(plan.workflow?.action, 'match-inputs')
  assert.equal(plan.workflow?.modelId, 'carbon')
  assert.deepEqual(classifier.requests[0]?.tools, [])
})
