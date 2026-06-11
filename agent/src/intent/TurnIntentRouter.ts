import type { ArtifactInput, ModelAdapter } from '@gsms/agent-core'
import type { SkillSummary } from '@gsms/skills-core'

export type TurnIntent = 'general-answer' | 'invest-workflow' | 'workflow-continue' | 'ambiguous'
export type WorkflowAction =
  | 'assess-runnable-models'
  | 'match-inputs'
  | 'validate'
  | 'confirm'
  | 'execute'
  | 'inspect-results'
  | 'write-report'

export interface TurnIntentRoute {
  intent: TurnIntent
  reason: string
  confidence?: number
  workflowAction?: WorkflowAction
  modelId?: string
  exposeSkills?: string[]
}

export interface TurnPlan {
  intent: TurnIntent
  confidence: number
  reason: string
  workflow?: {
    action?: WorkflowAction
    modelId?: string
    continuationTarget?: string
  }
  toolPolicy: {
    exposeGsmsTools: boolean
    exposeSkills: string[]
    useWorkflowPhaseFilter: boolean
  }
  promptContext: {
    includeSceneId: boolean
    includeDomainState: boolean
    includeWorkflowResumeContext: boolean
    clarificationQuestion?: string
  }
}

export interface TurnIntentRouterOptions {
  classifierModel?: ModelAdapter
}

export interface RouteTurnInput {
  userMessage: string
  domainState?: Record<string, unknown>
  artifacts?: readonly unknown[]
  skillSummaries?: readonly SkillSummary[]
}

const CONTINUE_KEYWORDS = [
  'continue', 'go on', 'next step', 'resume', 'proceed',
  '继续', '下一步', '接着', '验证刚才', '运行它', '执行它', '生成报告', '写报告',
]

const INVEST_KEYWORDS = [
  'invest', 'carbon', 'habitat quality', 'sdr', 'ndr', 'annual water yield',
  'model schema', 'input schema', 'data card', 'binding',
  'match', 'validate', 'validation', 'run model', 'execute validated snapshot', 'job',
  '碳储量', '碳存储', '生境质量', '匹配', '验证',
]

const CURRENT_PROJECT_HINTS = [
  'current', 'this scene', 'current scene', '当前', '本场景', '这个场景', '当前场景',
]

const CONCEPT_PATTERNS = [
  /^(explain|what is|what are|介绍|解释|说明|什么是).+/i,
  /^请?(?:介绍|解释|说明).+/i,
  /概念/,
]

const ARITHMETIC_PATTERN = /^\s*(?:what\s+is\s+)?[-+*/().\d\s]+=?\s*(?:\?|？)?\s*$/i

const hasAny = (text: string, keywords: readonly string[]) =>
  keywords.some(keyword => text.includes(keyword))

export class TurnIntentRouter {
  constructor(readonly options: TurnIntentRouterOptions = {}) {}

  async route(input: RouteTurnInput): Promise<TurnPlan> {
    const message = input.userMessage.trim()
    const text = message.toLowerCase()
    if (!message) return buildTurnPlan({ intent: 'ambiguous', reason: 'empty user message', confidence: 1 })

    const canContinue = hasContinuableWorkflow(input.domainState, input.artifacts)
    if (isContinueRequest(text)) {
      const workflowAction = inferWorkflowAction(text) ?? inferContinuationAction(input.domainState, input.artifacts)
      const route = canContinue
        ? {
            intent: 'workflow-continue' as const,
            reason: 'continuation request with workflow state',
            confidence: 0.9,
            workflowAction,
          }
        : {
            intent: 'ambiguous' as const,
            reason: 'continuation request without workflow state',
            confidence: 0.75,
          }
      return buildTurnPlan(route, input.skillSummaries)
    }

    const deterministic = routeByRules(message, text, input.skillSummaries, input.domainState, input.artifacts)
    if (deterministic) return buildTurnPlan(deterministic, input.skillSummaries)

    const llmRoute = await this.#routeWithClassifier(input)
    return buildTurnPlan(llmRoute ?? {
      intent: 'ambiguous',
      reason: 'no deterministic route and classifier unavailable',
      confidence: 0.4,
    }, input.skillSummaries)
  }

  async #routeWithClassifier(input: RouteTurnInput): Promise<TurnIntentRoute | undefined> {
    if (!this.options.classifierModel) return undefined
    const state = input.domainState ?? {}
    const artifacts = summarizeArtifacts(input.artifacts ?? [])
    try {
      const response = await this.options.classifierModel.complete({
        tools: [],
        messages: [
          {
            role: 'system',
            content:
              'Classify the user turn for a GSMS InVEST agent. Return only JSON: {"intent":"general-answer|invest-workflow|workflow-continue|ambiguous","confidence":0.0-1.0,"reason":"short reason","workflowAction":"assess-runnable-models|match-inputs|validate|confirm|execute|inspect-results|write-report","modelId":"optional model id"}. Do not call tools.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: input.userMessage,
              domainState: state,
              artifacts,
            }),
          },
        ],
      })
      const parsed = JSON.parse(response.content) as Partial<TurnIntentRoute>
      if (isTurnIntent(parsed.intent) && typeof parsed.reason === 'string') {
        return {
          intent: parsed.intent,
          reason: parsed.reason,
          confidence: typeof parsed.confidence === 'number' ? clampConfidence(parsed.confidence) : 0.6,
          workflowAction: isWorkflowAction(parsed.workflowAction) ? parsed.workflowAction : undefined,
          modelId: typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }
}

export function routeTurnIntent(input: RouteTurnInput): TurnIntentRoute {
  const message = input.userMessage.trim()
  const text = message.toLowerCase()
  if (!message) return { intent: 'ambiguous', reason: 'empty user message' }
  const canContinue = hasContinuableWorkflow(input.domainState, input.artifacts)
  if (isContinueRequest(text)) {
    return canContinue
      ? {
          intent: 'workflow-continue',
          reason: 'continuation request with workflow state',
          workflowAction: inferWorkflowAction(text) ?? inferContinuationAction(input.domainState, input.artifacts),
        }
      : { intent: 'ambiguous', reason: 'continuation request without workflow state' }
  }
  return routeByRules(message, text, input.skillSummaries, input.domainState, input.artifacts) ??
    { intent: 'ambiguous', reason: 'no deterministic route and classifier unavailable' }
}

export function planTurnIntent(input: RouteTurnInput): TurnPlan {
  return buildTurnPlan(routeTurnIntent(input), input.skillSummaries)
}

export function summarizeTurnPlan(plan: TurnPlan): Record<string, unknown> {
  return {
    intent: plan.intent,
    confidence: plan.confidence,
    reason: plan.reason,
    workflow: plan.workflow,
    toolPolicy: {
      exposeGsmsTools: plan.toolPolicy.exposeGsmsTools,
      exposeSkills: plan.toolPolicy.exposeSkills,
      useWorkflowPhaseFilter: plan.toolPolicy.useWorkflowPhaseFilter,
    },
    promptContext: {
      includeSceneId: plan.promptContext.includeSceneId,
      includeDomainState: plan.promptContext.includeDomainState,
      includeWorkflowResumeContext: plan.promptContext.includeWorkflowResumeContext,
      hasClarificationQuestion: Boolean(plan.promptContext.clarificationQuestion),
    },
  }
}

function routeByRules(
  message: string,
  text: string,
  skillSummaries: readonly SkillSummary[] = [],
  domainState?: Record<string, unknown>,
  artifacts?: readonly unknown[],
): TurnIntentRoute | undefined {
  if (ARITHMETIC_PATTERN.test(message)) {
    return { intent: 'general-answer', reason: 'simple arithmetic or expression', confidence: 0.95 }
  }
  if (/^(hi|hello|hey|thanks|thank you|你好|您好|谢谢|早上好|晚上好)[!！。.\s]*$/i.test(message)) {
    return { intent: 'general-answer', reason: 'greeting or small talk', confidence: 0.95 }
  }
  if (isTranslationRequest(text)) {
    return { intent: 'general-answer', reason: 'translation request', confidence: 0.9 }
  }
  if (CONCEPT_PATTERNS.some(pattern => pattern.test(message)) && !hasAny(text, CURRENT_PROJECT_HINTS)) {
    return { intent: 'general-answer', reason: 'conceptual explanation without current scene request', confidence: 0.85 }
  }
  const skillRoute = routeBySkillMetadata(text, skillSummaries)
  if (skillRoute) return skillRoute
  const workflowAction = inferWorkflowAction(text)
  if (workflowAction && hasContinuableWorkflow(domainState, artifacts)) {
    return {
      intent: 'invest-workflow',
      reason: 'workflow action request with existing workflow state',
      confidence: 0.84,
      workflowAction,
      modelId: inferModelId(text),
      exposeSkills: skillsForWorkflowAction(workflowAction, skillSummaries),
    }
  }
  if (hasAny(text, CURRENT_PROJECT_HINTS) && inferWorkflowAction(text)) {
    return {
      intent: 'invest-workflow',
      reason: 'current GSMS scene workflow request',
      confidence: 0.82,
      workflowAction,
      modelId: inferModelId(text),
      exposeSkills: skillsForWorkflowAction(workflowAction, skillSummaries),
    }
  }
  if (hasAny(text, INVEST_KEYWORDS)) {
    const workflowAction = inferWorkflowAction(text)
    return {
      intent: 'invest-workflow',
      reason: 'explicit GSMS or InVEST workflow keyword',
      confidence: 0.8,
      workflowAction,
      modelId: inferModelId(text),
      exposeSkills: skillsForWorkflowAction(workflowAction, skillSummaries),
    }
  }
  if (isPlainQuestion(message)) {
    return { intent: 'general-answer', reason: 'plain question without workflow keyword', confidence: 0.65 }
  }
  return undefined
}

function buildTurnPlan(route: TurnIntentRoute, skillSummaries: readonly SkillSummary[] = []): TurnPlan {
  const confidence = clampConfidence(route.confidence ?? defaultConfidence(route.intent))
  if (route.intent === 'general-answer') {
    return {
      intent: route.intent,
      confidence,
      reason: route.reason,
      toolPolicy: { exposeGsmsTools: false, exposeSkills: [], useWorkflowPhaseFilter: false },
      promptContext: {
        includeSceneId: false,
        includeDomainState: false,
        includeWorkflowResumeContext: false,
      },
    }
  }
  if (route.intent === 'ambiguous') {
    return {
      intent: route.intent,
      confidence,
      reason: route.reason,
      toolPolicy: { exposeGsmsTools: false, exposeSkills: [], useWorkflowPhaseFilter: false },
      promptContext: {
        includeSceneId: false,
        includeDomainState: false,
        includeWorkflowResumeContext: false,
        clarificationQuestion: '请问你是想普通问答，还是要继续当前 InVEST 场景工作流？',
      },
    }
  }
  return {
    intent: route.intent,
    confidence,
    reason: route.reason,
    workflow: {
      action: route.workflowAction,
      modelId: route.modelId,
      continuationTarget: route.intent === 'workflow-continue' ? route.workflowAction : undefined,
    },
    toolPolicy: {
      exposeGsmsTools: true,
      exposeSkills: route.exposeSkills ?? skillsForWorkflowAction(route.workflowAction, skillSummaries),
      useWorkflowPhaseFilter: true,
    },
    promptContext: {
      includeSceneId: true,
      includeDomainState: true,
      includeWorkflowResumeContext: true,
    },
  }
}

function routeBySkillMetadata(
  text: string,
  skillSummaries: readonly SkillSummary[],
): TurnIntentRoute | undefined {
  for (const skill of skillSummaries) {
    const examples = skill.triggerExamples ?? []
    const matchedExample = examples.find(example => {
      const normalized = example.trim().toLowerCase()
      return normalized.length >= 4 && (text.includes(normalized) || normalized.includes(text))
    })
    if (!matchedExample) continue
    const action = workflowActionFromSkillTags(skill.intentTags) ?? inferWorkflowAction(text)
    return {
      intent: 'invest-workflow',
      reason: `matched skill metadata trigger for ${skill.name}`,
      confidence: 0.78,
      workflowAction: action,
      modelId: inferModelId(text),
      exposeSkills: [skill.name],
    }
  }
  return undefined
}

function workflowActionFromSkillTags(tags: readonly string[] | undefined): WorkflowAction | undefined {
  if (!tags?.length) return undefined
  if (tags.some(tag => ['assess-runnable-models', 'assess-data-sufficiency', 'explore-data'].includes(tag))) {
    return 'assess-runnable-models'
  }
  if (tags.includes('match-inputs')) return 'match-inputs'
  if (tags.includes('validate')) return 'validate'
  if (tags.includes('confirm')) return 'confirm'
  if (tags.includes('execute')) return 'execute'
  if (tags.includes('inspect-results')) return 'inspect-results'
  if (tags.includes('write-report')) return 'write-report'
  return undefined
}

function skillsForWorkflowAction(
  action: WorkflowAction | undefined,
  skillSummaries: readonly SkillSummary[],
): string[] {
  const fallback =
    action === 'inspect-results' || action === 'write-report'
      ? ['interpret-invest-results']
      : ['data-matching', 'interpret-invest-results']
  if (!skillSummaries.length) return fallback

  const selected = skillSummaries
    .filter(skill => skillMatchesWorkflowAction(skill, action))
    .map(skill => skill.name)
  return selected.length ? selected : fallback.filter(name => skillSummaries.some(skill => skill.name === name))
}

function skillMatchesWorkflowAction(skill: SkillSummary, action: WorkflowAction | undefined): boolean {
  const tags = new Set(skill.intentTags ?? [])
  if (!action) return skill.name === 'data-matching'
  if (action === 'assess-runnable-models') {
    return tags.has('assess-runnable-models') || tags.has('assess-data-sufficiency') || tags.has('explore-data')
  }
  if (action === 'inspect-results' || action === 'write-report') {
    return tags.has(action) || skill.name === 'interpret-invest-results'
  }
  return tags.has(action) || (action === 'match-inputs' && skill.name === 'data-matching')
}

function defaultConfidence(intent: TurnIntent): number {
  switch (intent) {
    case 'general-answer': return 0.7
    case 'invest-workflow': return 0.7
    case 'workflow-continue': return 0.75
    case 'ambiguous': return 0.5
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

function inferWorkflowAction(text: string): WorkflowAction | undefined {
  if (
    text.includes('能跑') ||
    text.includes('可运行') ||
    text.includes('可以运行') ||
    text.includes('哪些模型') ||
    text.includes('which models') ||
    text.includes('can run') ||
    text.includes('runnable')
  ) return 'assess-runnable-models'
  if (text.includes('匹配') || text.includes('match') || text.includes('binding') || text.includes('输入')) return 'match-inputs'
  if (text.includes('报告') || text.includes('report')) return 'write-report'
  if (text.includes('结果') || text.includes('outputs') || text.includes('inspect')) return 'inspect-results'
  if (!isExecutionNegated(text) && (text.includes('运行') || text.includes('执行') || text.includes('execute') || text.includes('run model'))) return 'execute'
  if (text.includes('确认') || text.includes('confirm')) return 'confirm'
  if (text.includes('验证') || text.includes('validate') || text.includes('validation')) return 'validate'
  return undefined
}

function isExecutionNegated(text: string): boolean {
  return /(?:不要|别|不可|禁止|先不|暂不)\s*(?:运行|执行)/.test(text) ||
    /(?:do not|don't|dont|without)\s+(?:run|execute)/i.test(text)
}

function inferContinuationAction(
  state: Record<string, unknown> | undefined,
  artifacts: readonly unknown[] | undefined,
): WorkflowAction | undefined {
  const phase = typeof state?.phase === 'string' ? state.phase : ''
  if (phase === 'ready-for-validation') return 'validate'
  if (phase === 'awaiting-user-confirmation') return 'confirm'
  if (phase === 'confirmed-for-execution') return 'execute'
  if (phase === 'job-running') return 'inspect-results'
  if (phase === 'job-succeeded' || phase === 'outputs-inspected' || phase === 'results-analyzed') return 'inspect-results'
  if (phase === 'results-ready-for-interpretation' || phase === 'report-written') return 'write-report'
  if (phase === 'matching-slots' || phase === 'resolving-ambiguity') return 'match-inputs'
  if ((artifacts ?? []).some(artifact => isArtifactLike(artifact) && artifact.type === 'binding-report')) return 'validate'
  if ((artifacts ?? []).some(artifact => isArtifactLike(artifact) && artifact.type === 'validation-report')) return 'confirm'
  if ((artifacts ?? []).some(artifact => isArtifactLike(artifact) && artifact.type === 'confirmation-record')) return 'execute'
  return undefined
}

function inferModelId(text: string): string | undefined {
  if (text.includes('carbon') || text.includes('碳储量') || text.includes('碳存储')) return 'carbon'
  if (text.includes('habitat quality') || text.includes('生境质量')) return 'habitat_quality'
  if (text.includes('annual water yield') || text.includes('water yield')) return 'annual_water_yield'
  if (text.includes('sdr')) return 'sdr'
  if (text.includes('ndr')) return 'ndr'
  return undefined
}

function isTranslationRequest(text: string): boolean {
  return text.startsWith('translate ') ||
    text.includes(' translate ') ||
    text.includes('翻译') ||
    text.includes('译成')
}

function isPlainQuestion(message: string): boolean {
  const text = message.toLowerCase()
  return /[?？]\s*$/.test(message) ||
    text.startsWith('what ') ||
    text.startsWith('why ') ||
    text.startsWith('how ') ||
    text.startsWith('who ') ||
    text.startsWith('when ') ||
    text.startsWith('where ')
}

function isContinueRequest(text: string): boolean {
  return CONTINUE_KEYWORDS.some(keyword => text.includes(keyword))
}

function hasContinuableWorkflow(
  state: Record<string, unknown> | undefined,
  artifacts: readonly unknown[] | undefined,
): boolean {
  const phase = typeof state?.phase === 'string' ? state.phase : ''
  if ([
    'ready-for-validation',
    'awaiting-user-confirmation',
    'confirmed-for-execution',
    'job-running',
    'job-succeeded',
    'outputs-inspected',
    'results-analyzed',
    'results-ready-for-interpretation',
    'report-written',
    'matching-slots',
    'resolving-ambiguity',
  ].includes(phase)) return true

  return (artifacts ?? []).some(artifact => {
    if (!isArtifactLike(artifact)) return false
    return [
      'binding-report',
      'validation-report',
      'confirmation-record',
      'model-job',
      'job-status',
      'job-output-inventory',
      'result-analysis',
      'result-interpretation-context',
      'invest-report',
    ].includes(artifact.type)
  })
}

function summarizeArtifacts(artifacts: readonly unknown[]): Array<Pick<ArtifactInput, 'id' | 'type' | 'metadata'>> {
  return artifacts.filter(isArtifactLike).slice(-20).map(artifact => ({
    id: artifact.id,
    type: artifact.type,
    metadata: artifact.metadata,
  }))
}

function isArtifactLike(value: unknown): value is { id?: string; type: string; metadata?: Record<string, unknown> } {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
}

function isTurnIntent(value: unknown): value is TurnIntent {
  return value === 'general-answer' ||
    value === 'invest-workflow' ||
    value === 'workflow-continue' ||
    value === 'ambiguous'
}

function isWorkflowAction(value: unknown): value is WorkflowAction {
  return value === 'assess-runnable-models' ||
    value === 'match-inputs' ||
    value === 'validate' ||
    value === 'confirm' ||
    value === 'execute' ||
    value === 'inspect-results' ||
    value === 'write-report'
}
