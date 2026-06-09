# Plan: Agent 运行协议收敛 — stabilize-matching-session

## 核心诊断

当前系统有 6 个互相纠缠的问题，逐个修 bug 会越修越乱。需要一次性收敛。

### 已确认的 Bug

1. **`finish` gate 形同虚设**：`finish` 不在 `allDomainTools` 中，line 119 的 `!allDomainTools.has(tool.name)` 直接 `return true`，line 132 的 `finishPassesEvidenceGate` 永远不执行。

2. **`matchingContextId` 被 Worker 无条件清空**：每次新消息进入非 execution 阶段，`matchingContextId: null`，之前所有匹配证据变成无主孤儿。

3. **`phase` 被多个工具随机 patch**：`list_scene_data_cards` 设 `matching-slots`，`get_invest_model_schema` 设 `discovering-data`，后执行的覆盖先执行的。phase 不是逻辑状态，是工具副作用。

4. **`matchingContextId` 计算时机不一致**：`list_scene_data_cards` 用 `tryContextModelSchema`（可能返回 undefined）计算，`get_invest_model_schema` 用新 schema 重算。两个工具调用顺序不同，结果不同。

5. **Gate 结果只存在 artifact metadata**：`validate_binding_report` 从 `binding-report.metadata.gatePassed` 读取，不重新运行 gate。artifact 重建时 metadata 可能不一致。

6. **工具契约太弱**：`retrieve_input_candidates({ slot: string })` 让 LLM 猜 slot 名。

---

## 阶段一：状态模型收敛

### 1.1 修复 `finish` gate（紧急）

**文件：** `agent/src/workflowBoundary.ts`

在 `workflowPhaseFilter` 中，`finish` 的 gate 检查必须在 `!allDomainTools.has(tool.name)` 之前：

```ts
export function workflowPhaseFilter() {
  return (tool: AgentTool, context: AgentContext): boolean => {
    if (['skill', 'update_goal'].includes(tool.name)) return true
    // finish has its own evidence gate — check BEFORE the domain tools bypass
    if (tool.name === 'finish') return finishPassesEvidenceGate(context)
    if (!allDomainTools.has(tool.name)) return true
    // ... rest of logic
  }
}
```

### 1.2 停止 Worker 无条件清空 `matchingContextId`

**文件：** `agent/src/worker/InvestAgentWorker.ts`, `agent/src/cli/InvestAgentSession.ts`

Worker 不再在每条新消息时重置 `matchingContextId`。改为：只有当 sceneId 或 modelId 变化时才重置。

```ts
// 之前
if (!isExecutionPhase(currentPhase)) {
  domainState.applyPatch({ phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null })
}

// 之后
const previousSceneId = domainState.snapshot().sceneId
if (!isExecutionPhase(currentPhase) && previousSceneId !== session.scene_id) {
  // Scene changed — reset matching context
  domainState.applyPatch({ phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null })
} else if (!isExecutionPhase(currentPhase)) {
  // Same scene — preserve matching context, just reset phase for re-discovery
  domainState.applyPatch({ phase: 'discovering-data' })
}
```

### 1.3 让 `matchingContextId` 成为纯派生值

**文件：** `agent/src/tools/gsmsTools.ts`

`matchingContextId` 只由 `computeMatchingContextId(sceneId, schema, cards)` 计算，不由工具随意设置。

`list_scene_data_cards` 和 `get_invest_model_schema` 都调用 `computeMatchingContextId`。两者都读取当前已有的 data cards 和 schema 来计算。调用顺序不影响最终结果。

当前代码已经做了这个（`get_invest_model_schema` 在 data cards 存在时重算）。需要确保：
- `list_scene_data_cards` 在 schema 已存在时用 schema 计算
- `get_invest_model_schema` 在 data cards 已存在时用 cards 计算
- 两者都不存在时 `matchingContextId` 为 null（正常）

### 1.4 统一 `phase` 设置

**文件：** `agent/src/tools/gsmsTools.ts`, `agent/src/tools/matchingTools.ts`

普通 evidence tools（`list_scene_data_cards`、`retrieve_input_candidates`、`check_data_relation`）不再直接 patch `phase`。phase 只由以下工具设置：

| 工具 | 设置的 phase |
|------|-------------|
| Worker（新消息重置） | `discovering-data` |
| `get_invest_model_schema` | `discovering-data` |
| `finalize_data_matching` | `ready-for-validation` / `resolving-ambiguity` |
| `validate_binding_report` | `awaiting-user-confirmation` / `validation-failed` |
| `confirm_validation_snapshot` | `confirmed-for-execution` / `confirmation-rejected` |
| `execute_validated_snapshot` | `job-running` |
| `get_invest_job_status` | `job-running` / `job-succeeded` / `job-failed` |
| `inspect_invest_job_outputs` | `outputs-inspected` |
| `analyze_invest_results` | `results-analyzed` |
| `interpret_invest_results` | `results-ready-for-interpretation` |
| `write_invest_report` | `report-written` |
| `finalize_sufficiency_assessment` | `sufficiency-assessed` |

`list_scene_data_cards` 和 `retrieve_input_candidates` 不再设置 phase。

---

## 阶段二：工具前置条件收敛

### 2.1 新增 `retrieve_required_input_candidates`

**文件：** `agent/src/tools/matchingTools.ts`

新增工具，一次性为所有 required slots 生成候选集：

```ts
{
  name: 'retrieve_required_input_candidates',
  description: 'Retrieve candidates for all required input slots of the current model',
  inputSchema: { type: 'object', required: ['modelId'], properties: { modelId: { type: 'string' } } },
  async execute(input, context) {
    const schema = latestModelSchema(context)
    const cards = dataCards(context)
    const matchingContextId = currentMatchingContext(context)
    const results = []
    for (const slot of schema.slots.filter(s => s.required)) {
      const candidates = retrieveCandidates(slot, cards)
      // create artifact...
      results.push({ slot: slot.name, candidateCount: candidates.candidates.length })
    }
    return { content: JSON.stringify(results), artifacts: [...], statePatch: { ... } }
  }
}
```

保留 `retrieve_input_candidates` 给高级补充调查（可选 slot、重新检索等）。

### 2.2 结构化前置条件错误

所有匹配工具的前置条件错误统一格式：

```ts
{ code: 'PREREQUISITE_MISSING', message: '...', nextAction: { tool: '...', input: {...} } }
```

已有的：
- `MATCHING_CONTEXT_MISSING` → nextAction: `list_scene_data_cards`
- `UNKNOWN_SLOT` → nextAction: `retrieve_input_candidates` with valid slot

需要新增：
- `SCHEMA_REQUIRED` → nextAction: `get_invest_model_schema`
- `DATA_CARDS_REQUIRED` → nextAction: `list_scene_data_cards`

---

## 阶段三：DataMatchingGate 成为唯一匹配出口

### 3.1 Gate 结果作为独立 artifact

**文件：** `agent/src/tools/matchingTools.ts`

`finalize_data_matching` 不再把 gate 结果塞在 binding-report metadata 里。改为创建独立的 `data-matching-gate-result` artifact：

```ts
artifacts: [
  { type: 'binding-report', ... },
  { type: 'data-matching-gate-result', createdBy: 'tool', data: gate, metadata: { modelId, sceneId, matchingContextId } },
]
```

### 3.2 `validate_binding_report` 重新运行 gate

**文件：** `agent/src/tools/gsmsTools.ts`

`validate_binding_report` 不再从 metadata 读 gate 结果。改为重新运行 `checkDataMatchingGate(context)`：

```ts
const gate = checkDataMatchingGate(context)
if (!gate.passed) {
  return { content: JSON.stringify({ status: 'gate-blocked', gate }), diagnostics: [...] }
}
// proceed with backend validation...
```

---

## 阶段四：Workflow Boundary 收敛

### 4.1 Boundary 只做三件事

1. **当前请求禁止什么**：用户说"不要执行" → execution tools 不可用
2. **执行阶段硬门禁**：严格单工具顺序（不变）
3. **finish 门禁**：根据 terminal artifact 判断

### 4.2 finish gate 按 terminal artifact 判断

```ts
function finishPassesEvidenceGate(context: AgentContext): boolean {
  const artifacts = context.artifacts.list()
  const state = context.domainState.snapshot()
  const matchingContextId = typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined

  // Terminal artifacts — always allow finish
  const terminalTypes = ['sufficiency-report', 'binding-report', 'invest-report', 'data-matching-gate-result']
  if (artifacts.some(a => terminalTypes.includes(a.type))) return true

  // Current-context artifacts
  const current = matchingContextId
    ? artifacts.filter(a => a.metadata?.matchingContextId === matchingContextId)
    : artifacts.filter(a => !a.metadata?.matchingContextId)

  // If agent started matching (has candidates), must have binding report
  if (current.some(a => a.type === 'candidate-set')) return false

  // Exploration evidence
  const hasSchema = current.some(a => a.type === 'model-input-schema')
  const hasDataCards = current.some(a => a.type === 'gsms-scene-data-cards')
  if (hasSchema && hasDataCards) return true
  if (current.some(a => a.type === 'gsms-model-list')) return true
  if (hasDataCards) return true

  return false
}
```

### 4.3 `matchingPhaseAllows` 收回部分可见性

不再 `return true`。根据当前 phase 收窄：

```ts
function matchingPhaseAllows(toolName: string, context: AgentContext): boolean {
  // Always visible in matching group
  const alwaysVisible = ['list_invest_models', 'get_invest_model_schema', 'list_scene_data_cards',
    'retrieve_input_candidates', 'retrieve_required_input_candidates', 'check_data_relation',
    'finalize_data_matching', 'finalize_sufficiency_assessment']
  if (alwaysVisible.includes(toolName)) return true

  // Downstream tools require specific evidence
  const artifacts = context.artifacts.list()
  const state = context.domainState.snapshot()
  const matchingContextId = typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined
  const current = matchingContextId
    ? artifacts.filter(a => a.metadata?.matchingContextId === matchingContextId)
    : []

  if (toolName === 'validate_binding_report') return current.some(a => a.type === 'binding-report')
  if (toolName === 'confirm_validation_snapshot') return artifacts.some(a => a.type === 'validation-report')
  if (toolName === 'execute_validated_snapshot') return artifacts.some(a => a.type === 'confirmation-record')

  return true
}
```

---

## 文件变更汇总

| 文件 | 变更 |
|------|------|
| `agent/src/workflowBoundary.ts` | 修复 finish gate；重写 matchingPhaseAllows；重写 finishPassesEvidenceGate |
| `agent/src/worker/InvestAgentWorker.ts` | 停止无条件清空 matchingContextId |
| `agent/src/cli/InvestAgentSession.ts` | 同上 |
| `agent/src/tools/gsmsTools.ts` | 统一 phase 设置；list_scene_data_cards 不再设 phase |
| `agent/src/tools/matchingTools.ts` | 新增 retrieve_required_input_candidates；统一前置条件错误 |
| `agent/src/gates/dataMatchingGate.ts` | 无变更（已正确） |
| `agent/skills/data-matching/SKILL.md` | 更新为推荐 retrieve_required_input_candidates |
| `agent/test/worker.test.ts` | 更新 finish gate 测试 |

## 测试计划

1. finish gate 生效：无 domain artifact 时 finish 被拦截
2. matchingContextId 持久化：新消息不丢失匹配上下文
3. phase 一致性：工具调用顺序不影响最终 phase
4. DataMatchingGate 独立运行：不依赖 metadata
5. 端到端 Carbon 匹配流程不变

## 不做的事

- 不做通用 Claim Validator
- 不做 intent 推断系统
- 不做 phase 自动派生
- 不做 Habitat / Water Yield 扩展
