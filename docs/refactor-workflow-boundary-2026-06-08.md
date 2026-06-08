# WorkflowBoundary 重构说明

**日期：** 2026-06-08
**分支：** `refactor/flexible-workflow-boundary`
**提交：** `bbd1cc0`

---

## 一、背景与动机

`workflowBoundary.ts` 是 GSMS Agent 的核心控制层，原设计通过两层机制将 Agent 锁定在严格线性管道中：

1. **`inferWorkflowBoundary(request)`**：正则匹配用户消息 → 五选一分类（matching / validation / confirmation / execution / interpretation）→ 决定工具可见性
2. **`phaseAllows(tool, context, boundary)`**：每个 domain phase 只允许一个工具 → 强制顺序执行

**原设计的问题：**

| 场景 | 原行为 | 期望行为 |
|------|--------|----------|
| 用户在 confirmation 阶段说"换一组数据重匹配" | Agent 无法调用 matching 工具（被 boundary 隐藏） | 应回退到 matching 阶段 |
| 用户说"帮我看看碳储量结果"（但作业还在跑） | 只有 `get_invest_job_status` 可用，无法做其他事 | 正确限制，但应更清晰地表达 |
| 用户在 ready-for-validation 时想直接执行 | 被 boundary 阻挡，必须先过 validation | 在 soft boundary 下可由 Agent 决定是否跳步 |
| `inferWorkflowBoundary` 正则匹配"执行"和"匹配"同时出现 | 取决于正则优先级，行为不可预测 | 不应依赖正则做硬门禁 |

## 二、设计原则

**保留硬门禁，开放软边界。**

将 16 个 domain phase 分为两组：

### Matching 组（软边界，允许回退）

| Phase | 含义 |
|-------|------|
| `conversation-ready` | 初始状态 |
| `discovering-data` | 加载模型 schema |
| `matching-slots` | 检索候选数据 |
| `resolving-ambiguity` | 候选未完全确定 |
| `ready-for-validation` | 匹配完成，待验证 |
| `awaiting-user-confirmation` | 验证通过，待用户确认 |
| `validation-failed` | 验证失败 |
| `confirmation-rejected` | 用户拒绝确认 |

**行为：** 组内所有工具可用，包括 validation / confirmation / execution 工具。Agent 可自由前进或回退。

### Execution 组（硬门禁，严格顺序）

| Phase | 唯一允许的工具 |
|-------|---------------|
| `confirmed-for-execution` | `execute_validated_snapshot` |
| `job-running` | `get_invest_job_status` |
| `job-failed` | `get_invest_job_status` |
| `job-succeeded` | `inspect_invest_job_outputs` |
| `outputs-inspected` | `analyze_invest_results` |
| `results-analyzed` | `interpret_invest_results` |
| `results-ready-for-interpretation` | `write_invest_report` |
| `report-written` | `get_invest_job_status` |

**行为：** 严格单工具限制，不可回退到 matching 组。保证科学计算的确定性和可审计性。

## 三、代码变更

### 3.1 `agent/src/workflowBoundary.ts`（重写）

**删除：**
- `WorkflowBoundary` 类型（五选一字符串联合）
- `boundaryTools` 映射
- `boundaryOrder` 数组
- `inferWorkflowBoundary(request)` 函数
- `workflowToolFilter(boundary)` 函数

**新增：**
- `PhaseGroup` 类型（`'matching' | 'execution'`）
- `phaseGroupMap` — 16 个 phase 到 group 的映射
- `getPhaseGroup(phase)` / `isExecutionPhase(phase)` — 导出函数
- `workflowPhaseFilter()` — 无参数，返回基于当前 phase 的过滤器
- `executionPhaseAllows(tool, phase)` — 硬门禁逻辑
- `matchingPhaseAllows(tool, context)` — 软边界逻辑（含前置条件检查）

### 3.2 `agent/src/worker/InvestAgentWorker.ts`

- import 从 `inferWorkflowBoundary, workflowToolFilter` 改为 `isExecutionPhase, workflowPhaseFilter`
- 状态重置逻辑：从 `workflowBoundary === 'matching'` 改为 `!isExecutionPhase(currentPhase)`
- 移除 `workflowBoundary` 变量和对 `domainState` 的 `workflowBoundary` 字段写入
- 系统提示从 "Do not act beyond this boundary" 改为描述 phase group 行为
- `toolFilter` 从 `workflowToolFilter(workflowBoundary)` 改为 `workflowPhaseFilter()`

### 3.3 `agent/src/cli/InvestAgentSession.ts`

与 3.2 相同的模式。

### 3.4 `agent/skills/data-matching/SKILL.md`

第 8 步从 "Respect the current workflow boundary" 改为 "The phase filter controls tool availability. You may call tools from earlier phases if the user requests changes to previous decisions."

### 3.5 `agent/test/worker.test.ts`

- import 更新为新 API
- 旧测试 `matching boundary hides validation, confirmation, and execution tools` 拆分为两个：
  - `phase filter allows cross-group tools in matching phase (soft boundary)` — 验证 matching 组可访问 validation/confirmation/execution 工具
  - `phase filter enforces hard gate in execution phase` — 验证 execution 组严格限制

## 四、未修改的部分

| 组件 | 原因 |
|------|------|
| 工具自身的 phase 检查（`gsmsTools.ts` 等） | 保留为 defense-in-depth |
| `AgentRuntime.ts` | `toolFilter` 接口不变 |
| `DomainStateStore` / `ArtifactStore` | 不受影响 |
| Session 状态机（`agent_sessions.py`） | 服务端状态机不变 |
| 确认流程（`PermissionManager`） | 不受影响 |
| `agent-workflow.test.ts` | happy path 不变，已验证通过 |

## 五、测试结果

```
# tests 9
# pass 9
# fail 0
```

包括：
- 7 个原有测试（全部通过）
- 2 个新测试（soft boundary + hard gate）

端到端测试 `agent-workflow.test.ts` 也通过。

## 六、行为变化总结

| 维度 | 之前 | 之后 |
|------|------|------|
| 工具可见性来源 | 正则推断 boundary → 静态工具集 | 当前 phase → phase group → 动态工具集 |
| Matching 阶段访问 validation 工具 | ❌ 被隐藏 | ✅ 可见（Agent 自主决定） |
| Execution 阶段回退到 matching | ❌ 不可能 | ❌ 不可能（硬门禁不变） |
| 复合意图（"重新匹配并重跑"） | 取决于正则优先级 | Agent 可逐步调用所需工具 |
| 状态重置 | boundary === matching 时重置 | 非 execution phase 时重置 |
| 科学计算正确性保障 | ✅ | ✅（execution 组硬门禁不变） |
