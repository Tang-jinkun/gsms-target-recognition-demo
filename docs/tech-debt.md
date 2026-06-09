# 技术债务记录

> **此文档用于记录当前不够成熟的设计**——包括写死的逻辑、紧耦合的组件、临时方案等。每条记录附带发现时间和问题描述。目的是在未来重构时有据可依。

---

## 1. workflowDirective 硬编码 phase → 指令映射

**发现时间**：2026-06-09

**位置**：`agent/src/worker/InvestAgentWorker.ts` → `workflowDirective()` 函数

**问题**：每个 workflow phase 对应一条硬编码的自然语言指令（如 `phase === 'confirmed-for-execution'` → `'Call execute_validated_snapshot immediately...'`）。新增 phase 必须手动添加条目，指令与工具名紧耦合。

**当前行为**：函数是一个大型 if-else 链，根据 phase 和 artifact 计数返回固定字符串。

**理想方案**：工具自身返回 `nextAction` hint，或从 artifact 状态自动推导下一步，或用 skill 文件声明阶段行为。

---

## 2. executionPhaseAllows 硬编码 phase → 工具白名单

**发现时间**：2026-06-09

**位置**：`agent/src/workflowBoundary.ts` → `executionPhaseAllows()` 函数

**问题**：execution 阶段的每个 phase 硬编码了唯一允许的工具名（如 `phase === 'job-running'` → 只允许 `get_invest_job_status`）。新增 phase 或工具需要手动修改。

**当前行为**：函数是一系列 `if (phase === X) return toolName === Y` 语句。

**理想方案**：用配置表或声明式映射替代硬编码逻辑。

---

## 3. confirm_validation_snapshot / execute_validated_snapshot 用 artifact 替代 phase 做门控

**发现时间**：2026-06-09

**位置**：`agent/src/tools/gsmsTools.ts` → `confirm_validation_snapshot` 和 `execute_validated_snapshot` 工具

**问题**：原先用 `state.phase` 做门控（如 `state.phase !== 'awaiting-user-confirmation'`），但 phase 跨 run 不可靠（Worker checkpoint 可能丢失 phase）。临时改为检查 artifact 存在性（`validation-report`、`confirmation-record`）。

**当前行为**：工具内部检查 `context.artifacts.list('validation-report')` 而非 `state.phase`。

**理想方案**：统一 phase 持久化机制，确保 phase 在 checkpoint 后不丢失，然后恢复用 phase 做门控（phase 是更语义化的 contract）。

---

## 4. Worker WAITING_PHASES 硬编码列表

**发现时间**：2026-06-09

**位置**：`agent/src/worker/InvestAgentWorker.ts` 和 `agent/src/cli/InvestAgentSession.ts`

**问题**：Worker 在每次 run 开始时重置 phase 为 `discovering-data`，但需要跳过"等待用户操作"的 phase。这些 phase 通过硬编码的 `WAITING_PHASES` Set 维护。

**当前行为**：`const WAITING_PHASES = new Set(['awaiting-user-confirmation', 'validation-failed', 'confirmation-rejected', 'ready-for-validation'])`

**理想方案**：phase 定义中自带 `persistAcrossRuns` 属性，Worker 根据属性决定是否重置。

---

## 5. workflowPhaseFilter 中 finish 门控位置脆弱

**发现时间**：2026-06-09

**位置**：`agent/src/workflowBoundary.ts` → `workflowPhaseFilter()` 函数

**问题**：`finish` 工具的证据门控（`finishPassesEvidenceGate`）必须在 `!allDomainTools.has(tool.name)` 检查之前执行，否则 `finish` 会被错误放行。这个顺序依赖是隐式的，没有注释或断言保护。

**当前行为**：`finish` 检查在 domain tools bypass 之前，且只在 matching group 生效。

**理想方案**：将 `finish` 加入 `allDomainTools`，或用独立的 control tool 注册机制，消除顺序依赖。

---

## 6. phaseGroupMap 硬编码 phase → group 映射

**发现时间**：2026-06-09

**位置**：`agent/src/workflowBoundary.ts` → `phaseGroupMap`

**问题**：每个 phase 属于哪个 group（matching / execution）是硬编码的 Record。新增 phase 必须手动添加。

**当前行为**：`const phaseGroupMap: Record<string, PhaseGroup> = { 'conversation-ready': 'matching', ... }`

**理想方案**：phase 定义中自带 group 属性，或从 phase 名称自动推导 group。

---

*此文档应随设计演进持续更新。每解决一条债务，标注解决时间和方案。*
