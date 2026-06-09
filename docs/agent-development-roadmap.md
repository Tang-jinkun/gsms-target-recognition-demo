# 智能体开发路线图

**日期：** 2026-06-09
**目的：** 将三份分析文档落为可执行的开发计划，按里程碑排序，每项含目标、改动文件、验收标准与依赖。

**配套文档（先读）：**
- `agent-intelligence-improvement-plan.md` — 痛点诊断（`matchingContextId` 抖动、多模型普查、啰嗦）
- `agent-design-review-vs-claude-code.md` — 与 Claude Code 成熟设计的对比与吸纳项
- `tech-debt.md` — 结构性硬编码债务

**总原则：**
- 保留 GSMS 核心：证据门控（Gate）+ Workflow Boundary + 确定性后端计算。所有改动不得破坏这三者。
- 每项独立可测、可单独部署；优先运行时止血，再做结构优化。
- 不触碰 `packages/agent-core` 的领域无关性，除非确有跨 Agent 价值（如收益递减停，属通用运行时能力）。

---

## 里程碑 M1：止血——消除空转与上下文抖动（P0）

**目标：** 直接消除用户观察到的"步数膨胀 + 反复重载 + 空转"症状。三项可并行。

### M1-1　数据卡与模型解耦（改进计划 P0-A）— ✅ 已完成 2026-06-09

**问题：** `matchingContextId = hash(sceneId + 模型schema + 数据卡)`，切模型 → hash 变 → 数据卡被过滤 → 候选归零 → 反复重载。

**改动：**
- `agent/src/tools/matchingTools.ts`
  - 新增 `computeSceneDataContextId(sceneId, cards)`：hash(sceneId + 资产指纹)，不含模型。
  - `dataCards()` 改用 `sceneDataContextId` 过滤，不再用 `matchingContextId`。
- `agent/src/tools/gsmsTools.ts`
  - `list_scene_data_cards`：数据卡 artifact 改用 `sceneDataContextId` 打标签，statePatch 写 `sceneDataContextId`。
  - `get_invest_model_schema`：保留 `matchingContextId`（candidate-set / binding-report 仍需它），但数据卡不再受模型切换影响。
- `agent/src/gates/dataMatchingGate.ts`：数据卡改用 `sceneDataContextId` 过滤；candidate-set / relation-check 仍用 `matchingContextId`。
- 新增 `agent/test/data-card-context.test.ts`（6 个测试）。
- `agent/test/worker.test.ts` 全绿（10 个测试）。

**依赖：** 无。

### M1-2　多模型普查工具（改进计划 P0-B）— ✅ 已完成 2026-06-09

**目标：** "哪些模型能跑"从"循环 N 个模型、切 N 次 schema"变成一次确定性工具调用。

**改动：**
- `agent/src/tools/gsmsTools.ts`：新增 `assess_scene_runnable_models` 工具。
  - 一次调用 `listModels` + `listSceneDataCards`，对每个模型用 `retrieveCandidates` 做确定性匹配，结合 runner 可用性。
  - 输出 per-model `{ runnable, runnerAvailable, dataSufficient, slots }`。
  - 产出 `scene-runnable-assessment` artifact 作为可审计证据。
- `agent/src/workflowBoundary.ts`：
  - `matchingTools` 集合新增 `assess_scene_runnable_models`。
  - `finishPassesEvidenceGate` 新增 `scene-runnable-assessment` 作为终端证据。
- `agent/skills/data-matching/SKILL.md`：Mode A 增加"多模型普查"分支——优先调用此工具，不再逐模型循环。
- `agent/test/worker.test.ts` 全绿（18 个测试）。

**依赖：** 建议在 M1-1 之上（普查内部复用数据卡匹配，解耦后更稳）。可并行起草。

### M1-3　收益递减自动停（审阅 B）— ✅ 已完成 2026-06-09

**目标：** 运行时检测空转并主动收尾，防止"未到 maxTurns 但已无产出"的反复横跳。

**改动：**
- `packages/agent-core/src/agent/AgentRuntime.ts` 主循环：
  - 跟踪 `noProgressCount`（连续无新 artifact 的轮次）。
  - 连续 2 轮无新证据 → 注入 steering 消息（隐藏的 user 消息）。
  - 连续 4 轮 → 强制收尾，记 `AGENT_NO_PROGRESS` diagnostic。
- 新增 `agent/test/diminishing-returns.test.ts`（2 个测试）。
- `agent/test/worker.test.ts` + `agent/test/data-card-context.test.ts` 全绿。

**依赖：** 无。

---

## 里程碑 M2：上下文经济学——简洁与渐进披露（P1）

**目标：** 降低啰嗦、控制 prompt 膨胀，为模型增多做准备。

### M2-1　简洁性契约（审阅 C）— ✅ 已完成 2026-06-09

**改动：**
- `packages/agent-core/src/prompts/buildSystemPrompt.ts`：Rules 增加 Conciseness 段——工具调用之间最多一句话；不在中间叙述里草拟最终答案；结构化结果一行总结；不说"Now I will..."。

**验收：** 系统提示新增简洁约束；18 个测试全绿。

**依赖：** 无。

### M2-2　渐进式技能披露 + `when_to_use`（审阅 A）— ✅ 已完成 2026-06-09

**改动：**
- `packages/skills-core/src/types.ts`：`SkillDefinition` 和 `SkillSummary` 增加可选 `whenToUse` 字段。
- `packages/skills-core/src/SkillLoader.ts`：frontmatter schema 增加 `when-to-use`，解析写入 `whenToUse`。
- `packages/skills-core/src/SkillRegistry.ts`：`formatForModel()` 输出 `description — whenToUse` 格式；`#list()` 传递 `whenToUse`。
- `agent/skills/data-matching/SKILL.md`：frontmatter 增加 `when-to-use`；`description` 缩短为一行摘要。

**验收：** system prompt 中技能条目包含 `whenToUse` 指引；18 个测试全绿。

**依赖：** 无（与 M2-1 并行完成）。

---

## 里程碑 M3：结构优化——可扩展性与上下文落盘（P2）

### M3-1　工具结果落盘到 artifact ✅

**改动：** `AgentTool` 新增 `persistResultAboveBytes` 字段；`StreamingToolExecutor` 在 `execute()` 返回后，若结果超阈值则自动存为 `tool-result` artifact，只把摘要 + artifact 引用回传模型。已在 `list_invest_models`（8KB）、`get_invest_model_schema`（8KB）、`list_scene_data_cards`（6KB）、`interpret_invest_results`（12KB）、`assess_scene_runnable_models`（8KB）上启用。

**完成时间：** 2026-01-26

### M3-2　buildTool 工厂 + 工具元数据 ✅

**改动：** 引入 `buildTool()` 工厂函数（`agent/src/tools/buildTool.ts`）统一构造 `AgentTool`。`gsmsTools.ts` 中大输出工具已迁移到 `buildTool`。

**完成时间：** 2026-01-26

### M3-3　偿还结构性硬编码债务 ✅

**改动：**
- `executionPhaseAllows`（债务 2）— 重构为 `EXECUTION_PIPELINE` 数据驱动：每个 phase 对应一个 `allowedTool`，新 phase 只需加一行。
- `phaseGroupMap`（债务 6）— 改为从 `EXECUTION_PIPELINE` 自动推导，非 pipeline 的 phase 一律为 matching。
- `WAITING_PHASES`（债务 4）— 提取到 `workflowBoundary.ts` 作为单一来源，`InvestAgentSession` 和 `InvestAgentWorker` 共用。

**验收：** 57 项测试全部通过；workflow 行为不变。

**完成时间：** 2026-01-26

---

## 里程碑 M4：按需引入（P3）

仅在触发条件满足时启动，不提前做。

### M4-1　只读侦察子代理 ✅

**改动：** 新增 `run_reconnaissance` 工具（`agent/src/tools/reconTools.ts`），基于 `AgentRuntime` 生成隔离子代理：
- 子代理只能调用 `risk: 'read'` 的工具 + 专用 `finish` 工具（无证据门控）。
- 子代理拥有独立的 `ArtifactStore` 和 `DomainStateStore`，不污染父代理状态。
- 支持 `allowedTools` 精细控制和 `maxTurns`（默认 5，上限 10）。
- 已集成到 `cli.ts` 和 `InvestAgentWorker.ts`，`workflowBoundary.ts` 中归入 matching 组。
- 7 项专项测试覆盖：只读过滤、工具白名单、延迟模型注入、maxTurns 等。

**完成时间：** 2026-01-26

### M4-2　ToolSearch 延迟加载（待触发）
- **触发条件：** 工具数量显著增长（远超当前 ~15 个），延迟加载收益 > 复杂度。
- **当前状态：** 约 15 个工具，未达触发条件。当工具数 > 20 时，system prompt 只放工具名 + description，模型需要时再通过 ToolSearch 取 schema。

---

## 交付顺序与依赖图

```text
M1-1 (数据卡解耦) ──┬─→ M1-2 (普查工具) ──→ M3-1 (结果落盘)
                    │
M1-3 (收益递减停) ──┘
                         M2-1 (简洁契约) ──→ M2-2 (渐进披露)
                         M3-2 (工具元数据) ──→ M3-3 (声明式配置)
                                                M4-* (按触发条件)
```

| 里程碑 | 内容 | 优先级 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| M1 | 数据卡解耦 / 普查工具 / 收益递减停 | P0 | 低-中 | ✅ 已完成 |
| M2 | 简洁契约 / 渐进披露 | P1 | 低 | ✅ 已完成 |
| M3 | 结果落盘 / 元数据 / 偿还债务 | P2 | 中-高 | ✅ 已完成 |
| M4 | 子代理 / ToolSearch | P3 | 按需 | M4-1 ✅ / M4-2 待触发 |

## 直接下一步

**实施 M1 三项**（数据卡解耦 + 多模型普查工具 + 收益递减自动停）。它们直接消除用户观察到的症状，改动集中、各自可测、可独立部署，且不破坏证据门控架构。建议先做 M1-1（其余两项可在其基础上并行）。

---

*本路线图随实施推进更新；每完成一项，标注完成时间与实际方案，并回填对应分析文档。*
