# Plan: Refactor workflowBoundary.ts — 从"执行管道"到"受控对话"

## 背景

`workflowBoundary.ts` 是 GSMS Agent 的核心控制层，它通过两层机制将 Agent 锁定在严格线性管道中：

1. **`inferWorkflowBoundary`**：正则匹配用户消息 → 五选一分类 → 决定工具可见性
2. **`phaseAllows`**：每个 phase 只允许一个工具 → 强制顺序执行

这保证了科学计算的正确性，但牺牲了对话灵活性：无法回退、无法跳步、无法处理复合意图。

## 设计原则

**保留硬门禁，开放软边界。**

将 phase 分为两组：
- **执行阶段（hard gate）**：`job-running` → `job-succeeded` → `outputs-inspected` → `results-analyzed` → `results-ready-for-interpretation` → `report-written` — 这些阶段的顺序由真实计算产出决定，必须严格保持
- **规划阶段（soft boundary）**：`matching` / `validation` / `confirmation` 组 — 允许在组内自由移动，允许从后面的组回退到前面的组

## 修改方案

### Step 1: 重写 `agent/src/workflowBoundary.ts`

**核心改动：**

1. **新增 `PhaseGroup` 类型和映射**：
   ```ts
   type PhaseGroup = 'matching' | 'execution'
   
   const phaseGroups: Record<string, PhaseGroup> = {
     // matching 组 — 可回退
     'conversation-ready': 'matching',
     'discovering-data': 'matching',
     'matching-slots': 'matching',
     'resolving-ambiguity': 'matching',
     'ready-for-validation': 'matching',
     'awaiting-user-confirmation': 'matching',
     'validation-failed': 'matching',
     'confirmation-rejected': 'matching',
     // execution 组 — 严格顺序
     'confirmed-for-execution': 'execution',
     'job-running': 'execution',
     'job-failed': 'execution',
     'job-succeeded': 'execution',
     'outputs-inspected': 'execution',
     'results-analyzed': 'execution',
     'results-ready-for-interpretation': 'execution',
     'report-written': 'execution',
   }
   ```

2. **删除 `inferWorkflowBoundary`** — 不再作为硬门禁。

3. **删除 `workflowToolFilter(boundary)`** — 替换为 `workflowPhaseFilter()`。

4. **新增 `workflowPhaseFilter()`** — 无参数，返回基于当前 phase 的过滤器：
   - 执行阶段（hard gate）：保持现有的严格单工具限制
   - 规划阶段（soft boundary）：允许当前组及更早组的所有工具
   - 回退检测：如果当前在 execution 组但请求的工具属于 matching 组，允许但注入回退诊断

5. **新增 `isExecutionPhase(phase)` 导出函数** — 用于 Worker/Session 判断是否需要重置状态。

6. **保留 `phaseAllows` 的 hard gate 逻辑** 用于执行阶段。

**文件变更：** `agent/src/workflowBoundary.ts`（重写）

---

### Step 2: 更新 `agent/src/worker/InvestAgentWorker.ts`

**改动：**

1. 改用 `workflowPhaseFilter` 替代 `workflowToolFilter(inferWorkflowBoundary(...))`
2. 用 `isExecutionPhase` 判断是否重置 matching 状态（替代 `workflowBoundary === 'matching'`）
3. 更新系统提示：从 "Do not act beyond this boundary" 改为描述当前阶段组和可用工具范围

**关键逻辑变化：**
```ts
// 之前
const workflowBoundary = inferWorkflowBoundary(latestUser.content)
domainState.applyPatch(
  workflowBoundary === 'matching'
    ? { workflowBoundary, phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null }
    : { workflowBoundary },
)
// ...
toolFilter: workflowToolFilter(workflowBoundary),

// 之后
const state = domainState.snapshot()
const shouldResetMatching = !isExecutionPhase(typeof state.phase === 'string' ? state.phase : '')
if (shouldResetMatching) {
  domainState.applyPatch({ phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null })
}
// ...
toolFilter: workflowPhaseFilter(),
```

**文件变更：** `agent/src/worker/InvestAgentWorker.ts`

---

### Step 3: 更新 `agent/src/cli/InvestAgentSession.ts`

与 Step 2 相同的模式：替换 `inferWorkflowBoundary` + `workflowToolFilter` 为 `workflowPhaseFilter` + `isExecutionPhase`。

**文件变更：** `agent/src/cli/InvestAgentSession.ts`

---

### Step 4: 更新 `buildWorkflowResumeContext`

更新 `workflowDirective` 函数，增加对回退场景的处理：
- 如果用户从 execution 回退到 matching，directive 应说明可以复用已有证据
- 移除对 `workflowBoundary` 的引用

**文件变更：** `agent/src/worker/InvestAgentWorker.ts`（`buildWorkflowResumeContext` 和 `workflowDirective` 函数）

---

### Step 5: 更新 Skills

**`agent/skills/data-matching/SKILL.md`：**
- 移除第 8 步 "Respect the current workflow boundary"
- 改为 "The phase filter controls tool availability. You may call tools from earlier phases if the user requests changes to previous decisions."

**`agent/skills/interpret-invest-results/SKILL.md`：**
- 无需改动（它不引用 boundary）

**文件变更：** `agent/skills/data-matching/SKILL.md`

---

### Step 6: 更新测试

**`agent/test/worker.test.ts`：**
- 重写 `'matching boundary hides validation, confirmation, and execution tools'` 测试
- 改为测试 `workflowPhaseFilter` 在不同 phase 下的行为
- 新增测试：matching 阶段可访问 validation 工具（soft boundary）
- 新增测试：execution 阶段严格限制（hard gate）

**`agent/test/agent-workflow.test.ts`：**
- 端到端测试应仍然通过（happy path 不变）
- 新增测试：回退场景（用户在 confirmation 阶段请求重新匹配）

**文件变更：** `agent/test/worker.test.ts`, `agent/test/agent-workflow.test.ts`

---

## 不改的部分

- **工具本身的 phase 检查**（`gsmsTools.ts`, `matchingTools.ts`, `reportTools.ts`）：保留作为 defense-in-depth
- **AgentRuntime.ts**：不改，`toolFilter` 接口不变
- **DomainStateStore / ArtifactStore**：不改
- **Session 状态机**（`agent_sessions.py`）：不改
- **确认流程**（PermissionManager）：不改

## 验证方式

1. `npm test` — 所有现有测试通过
2. 手动测试 CLI：在 matching 阶段尝试调用 validation 工具 → 应成功（soft boundary）
3. 手动测试 CLI：在 `job-running` 阶段尝试调用其他工具 → 应被拒绝（hard gate）
4. 手动测试 CLI：在 confirmation 阶段说"重新匹配数据" → 应回退到 matching
