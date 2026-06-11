import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeModelAdapter } from '@gsms/agent-core'
import { routeTurnIntent, TurnIntentRouter } from '../src/index.ts'

test('turn intent router classifies plain questions without starting workflow', () => {
  assert.equal(routeTurnIntent({ userMessage: '1+1=?' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '你好' }).intent, 'general-answer')
  assert.equal(routeTurnIntent({ userMessage: '解释一下碳储量模型的概念' }).intent, 'general-answer')
})

test('turn intent router classifies explicit GSMS and InVEST work', () => {
  assert.equal(routeTurnIntent({ userMessage: '当前场景能跑哪些模型？' }).intent, 'invest-workflow')
  assert.equal(routeTurnIntent({ userMessage: '帮我匹配 Carbon 模型输入' }).intent, 'invest-workflow')
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
