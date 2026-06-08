# Plan: Evidence-Gated Flexible Workflow

## 问题诊断

当前分支 `refactor/flexible-workflow-boundary` 的核心问题：

```ts
// workflowBoundary.ts — 现状
function matchingPhaseAllows(): boolean {
  return true  // 所有工具可见，无证据门禁
}
```

这导致：
1. 模型没拿 schema 就 finish（无证据交卷）
2. 没拿 data cards 就基于记忆总结
3. 没生成 candidate-set 就尝试验证
4. 工具太多导致选择路径随机
5. 工具失败后靠自然语言修补，而非按 artifact 推进

**根因：把"自由度"和"证据闭环"一起放松了。**

## 设计原则

```
LLM 决策策略和顺序（自由）
+ Skill 定义规程（引导）
+ Evidence Gate 验证产出（约束）
+ Tool 确定性执行（可靠）
+ Artifact 全链路审计（可追溯）
```

**一句话：模型自由选择路线，但每条路线必须经过 artifact 证据关卡。**

## 修改方案

### Step 1: 定义 Evidence Gate 规则

**文件：** `agent/src/workflowBoundary.ts`（新增 `evidenceGate.ts` 或在同文件中）

定义每个"可完成目标"的最低证据要求：

```ts
interface EvidenceRequirement {
  artifactTypes: string[]     // 必须存在的 artifact 类型
  minCount?: number           // 每种 artifact 的最少数量
  description: string         // 人类可读的描述
}

const EVIDENCE_GATES: Record<string, EvidenceRequirement> = {
  // "查看场景有什么数据" — 只需 data cards
  'explore-data': {
    artifactTypes: ['gsms-scene-data-cards'],
    description: 'Scene data cards must be loaded',
  },
  // "某模型数据是否足够" — 需要 schema + data cards + candidate sets
  'assess-sufficiency': {
    artifactTypes: ['model-input-schema', 'gsms-scene-data-cards', 'candidate-set'],
    description: 'Model schema, scene data, and candidate sets for required slots',
  },
  // "匹配数据" — 需要完整 binding report
  'match-inputs': {
    artifactTypes: ['model-input-schema', 'gsms-scene-data-cards', 'candidate-set', 'binding-report'],
    description: 'Full binding report with all required slots matched',
  },
  // "验证并执行" — 需要 validation report + confirmation
  'validate-and-execute': {
    artifactTypes: ['binding-report', 'validation-report', 'confirmation-record'],
    description: 'Validated and confirmed execution plan',
  },
}
```

### Step 2: 推断 WorkflowIntent

**文件：** `agent/src/workflowBoundary.ts`

取代旧的 `inferWorkflowBoundary` 正则匹配，改为基于 **已有 artifact + 用户消息** 推断意图：

```ts
type WorkflowIntent = 'explore-data' | 'assess-sufficiency' | 'match-inputs' | 'validate-and-execute'

function inferIntent(
  request: string,
  artifacts: Artifact[],
  domainState: DomainState,
): WorkflowIntent {
  // 1. 如果已有 binding-report → match-inputs 或更高
  // 2. 如果已有 candidate-set → assess-sufficiency 或 match-inputs
  // 3. 如果已有 data cards → explore-data 或 assess-sufficiency
  // 4. 结合用户消息关键词辅助判断
  // 5. 默认：explore-data（最轻量的意图）
}
```

关键区别：**不依赖正则硬判，而是基于已有证据 + 消息语义推断。**

### Step 3: 改造 `matchingPhaseAllows` — 加入 Evidence Gate

**文件：** `agent/src/workflowBoundary.ts`

```ts
function matchingPhaseAllows(toolName: string, context: AgentContext): boolean {
  // 始终可见的工具
  if (['skill', 'finish', 'update_goal', 'list_invest_models'].includes(toolName)) {
    // finish 有额外的 evidence gate 检查（见 Step 4）
    if (toolName === 'finish') return finishPassesEvidenceGate(context)
    return true
  }

  // 推断当前意图
  const intent = inferIntent(
    String(context.domainState.snapshot().lastUserRequest ?? ''),
    context.artifacts.list(),
    context.domainState.snapshot(),
  )
  const gate = EVIDENCE_GATES[intent]

  // 如果当前意图的证据已满足，所有工具可见（允许回滚修正）
  if (evidenceSatisfied(gate, context)) return true

  // 证据未满足时，按"推荐路径"收窄工具可见性
  return recommendedForCurrentEvidence(toolName, context, intent)
}
```

### Step 4: `finish` 的 Evidence Gate

**文件：** `packages/agent-core/src/tools/controlTools.ts`

改造 `finish` 工具，在 `execute` 中增加证据检查：

```ts
async execute(input, context) {
  const parsed = finishSchema.parse(input)
  if (parsed.status === 'completed') {
    // 检查是否有任何 domain artifact（非 control 工具产出）
    const domainArtifacts = context.artifacts.list().filter(
      a => !['goal-progress'].includes(a.type)
    )
    if (domainArtifacts.length === 0) {
      return {
        content: 'Cannot finish: no evidence artifacts produced. Call domain tools first.',
        diagnostics: [{ code: 'EVIDENCE_GATE_BLOCKED', message: '...', severity: 'error' }],
      }
    }
  }
  // ... existing logic
}
```

### Step 5: 新增 `finalize_sufficiency_assessment` 工具

**文件：** `agent/src/tools/gsmsTools.ts`（新增工具）

```ts
{
  name: 'finalize_sufficiency_assessment',
  description: 'Generate a deterministic sufficiency report for whether scene data can run a model',
  risk: 'read',
  inputSchema: {
    type: 'object',
    required: ['modelId', 'sceneId', 'slotAssessments'],
    properties: {
      modelId: { type: 'string' },
      sceneId: { type: 'string' },
      slotAssessments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slot', 'status', 'reasoning'],
          properties: {
            slot: { type: 'string' },
            status: { enum: ['available', 'missing', 'ambiguous'] },
            selectedAssetIds: { type: 'array', items: { type: 'string' } },
            reasoning: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
      },
    },
  },
  async execute(input, context) {
    // 确定性生成 sufficiency-report artifact
    // 不经过 LLM，纯工具逻辑
    const report = {
      modelId, sceneId, slotAssessments,
      overallStatus: /* 计算：all-available / has-missing / has-ambiguous */,
      runnable: /* boolean */,
      timestamp: new Date().toISOString(),
    }
    return {
      content: JSON.stringify(report, null, 2),
      artifacts: [{ type: 'sufficiency-report', createdBy: 'tool', data: report, metadata: { modelId, sceneId } }],
      statePatch: { phase: 'sufficiency-assessed' },
    }
  },
}
```

### Step 6: 更新 `data-matching` Skill

**文件：** `agent/skills/data-matching/SKILL.md`

增加两种工作流模式：

```markdown
## 模式 A：数据探索（explore-data）
当用户询问"场景有什么数据"或"能跑哪些模型"：
1. list_scene_data_cards（加载场景数据卡）
2. list_invest_models（加载可用模型列表）
3. 逐一 get_invest_model_schema（加载模型 schema）
4. 对每个模型：retrieve_input_candidates 检查必需槽
5. finalize_sufficiency_assessment（生成轻量报告）
6. finish

## 模式 B：数据匹配（match-inputs）
当用户请求"匹配数据"或"配置运行"：
1. get_invest_model_schema（加载目标模型 schema）
2. list_scene_data_cards（加载场景数据卡）
3. retrieve_input_candidates（逐槽检索候选）
4. check_data_relation（关系检查）
5. finalize_data_matching（生成 binding report）
6. finish

## Evidence Gate
- finish 前必须有至少一个 domain artifact
- 模式 A 需要：sufficiency-report
- 模式 B 需要：binding-report
```

### Step 7: 更新 `workflowDirective`

**文件：** `agent/src/worker/InvestAgentWorker.ts`

为数据探索和 sufficiency 评估阶段增加指引：

```ts
if (phase === 'discovering-data' || phase === 'matching-slots') {
  if (counts['gsms-model-list'] || counts['data-card'] || counts['gsms-scene-data-cards']) {
    if (counts['sufficiency-report']) {
      return 'Sufficiency assessment is complete. Call finish with the report findings.'
    }
    return 'Data loaded. If assessing sufficiency, retrieve candidates for required slots then call finalize_sufficiency_assessment. If matching, proceed with finalize_data_matching.'
  }
}
```

### Step 8: 更新测试

**文件：** `agent/test/worker.test.ts`

- 新增测试：`finish` 在无 evidence 时被拒绝
- 新增测试：有 sufficiency-report 时 `finish` 可见
- 新增测试：explore-data 意图下工具可见性正确
- 更新现有测试以匹配新的 matchingPhaseAllows 行为

## 不改的部分

| 组件 | 原因 |
|------|------|
| Execution 阶段逻辑 | 已经是严格顺序，无需改动 |
| `list_scene_data_cards` 无 schema 支持 | 保留，这是正确的改进 |
| `computeMatchingContextId` 可选 schema | 保留 |
| 前端 UI 改动 | 不在本次范围 |
| `AgentRuntime.ts` | 不改 |

## 提交策略

本次改动在 `refactor/flexible-workflow-boundary` 分支上继续，不新建分支。

## 验证

1. `npm test` — 所有测试通过
2. 手动测试：问"场景有什么数据" → Agent 加载 data cards → 生成 sufficiency-report → finish（不空转）
3. 手动测试：问"匹配 Carbon 数据" → Agent 完整走完 matching 流程
4. 手动测试：Agent 尝试无证据 finish → 被 evidence gate 拦截
