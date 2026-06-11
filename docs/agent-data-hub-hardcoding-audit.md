# Agent/Data Hub 流程硬编码审计

> **状态**：技术债梳理  
> **日期**：2026-06-11  
> **范围**：Agent Data Hub 主动探测、导入确认、导入后续跑、Workbench 思考卡/确认卡渲染  
> **不包含**：代码修改、架构迁移、模型匹配算法重写

---

## 1. 结论摘要

当前 Carbon 空场景到 Data Hub 推荐导入的闭环已经跑通，但成功依赖了一组具体规则：

- 空场景时禁止直接 sufficiency/readiness/finish，强制先 Data Hub discovery。
- 用户批准 `import_data_hub_files_to_scene` 后，Worker 直接执行导入工具，再让模型继续规划。
- 前端把 confirmation run 合并到同一个 assistant turn，并针对 Data Hub import payload 渲染推荐导入卡。

这些规则分成两类：

| 类型 | 判断 | 示例 |
| --- | --- | --- |
| 合理 guardrail | 应继续保留为明确协议 | 写工具必须用户确认、导入后必须刷新 scene data cards、finish 必须有证据 |
| 过拟合硬编码 | 应收敛成声明式 contract | Worker 特判 `import_data_hub_files_to_scene`、前端解析 Data Hub import payload、empty-scene gate 只认识 Data Hub |

建议后续按渐进式路线重构：先把散落的硬编码集中到 tool/workflow policy，再把 Data Hub-first 抽象成通用 data-source discovery policy，最后让前端只识别 confirmation contract 而不是具体工具。

---

## 2. 合理硬规则

这些规则不应交给 LLM 自觉遵守，应保留在代码层作为产品协议。

### 2.1 写操作必须经过用户确认

- **当前行为**：`import_data_hub_files_to_scene`、`confirm_validation_snapshot` 等受保护工具会暂停 run 并创建 confirmation。
- **判断**：合理。写入场景引用、确认执行快照都属于用户授权边界。
- **建议**：保留，但把“哪些工具需要确认、确认后如何续跑”从 Worker 特判迁移到 tool policy。
- **优先级**：P1。

### 2.2 导入 Data Hub 文件后必须刷新场景事实

- **当前行为**：导入工具执行后重新调用 scene data cards，并写入新的 `gsms-scene-data-cards` artifact。
- **判断**：合理。导入改变了当前 scene 的数据宇宙，旧的 missing 结论必须失效。
- **进展**：2026-06-11 已完成第一步，`AgentTool.policy.mutation.refreshesArtifacts` 声明 mutation 后会刷新哪些 artifact；`workflowPhaseFilter` 的 finish gate 已消费该 policy，刷新完成前不能 finish。Data Hub import 产物同时写入通用 `refreshedAfterMutation` 和兼容字段 `refreshedAfterImport`。
- **建议**：后续把 mutation record 的 schema 固化为通用 artifact contract，并让更多写工具声明自己的刷新事实。
- **优先级**：P0，第一阶段已完成。

### 2.3 finish 必须有足够证据

- **当前行为**：`finishPassesEvidenceGate` 阻止无证据或不完整证据的最终回答。
- **判断**：合理。否则 Agent 会把“当前场景为空”误答成“项目中无可用数据”。
- **建议**：保留 gate，但把 evidence requirement 从 if-else 收敛为 intent/workflow 声明。
- **优先级**：P0。

### 2.4 confirmation run 不应拆成多个 AI 气泡

- **当前行为**：包含 `confirmation` block 的 run 不消费 assistant message slot，后续 continuation 合并到同一个 turn。
- **判断**：合理。这是用户体验 contract，不应由具体工具决定。
- **建议**：保留现有行为，把“confirmation-gated run 是 continuation prefix”写入前端 activity projection contract。
- **优先级**：P1。

---

## 3. 过拟合硬编码清单

### 3.1 Empty Scene Data Hub-first gate

- **位置**：`agent/src/policies/dataAvailabilityPolicy.ts`、`agent/src/workflowBoundary.ts`、`agent/src/worker/InvestAgentWorker.ts`
- **当前行为**：当存在 `model-input-schema`、空 `gsms-scene-data-cards`、且没有外部数据发现证据时，只允许 discovery 等少数工具。
- **为什么需要**：防止 Agent 在空场景上直接生成 sufficiency/readiness 结论并触发无进展循环。
- **进展**：2026-06-11 已完成第一步，空场景 discovery gate 迁入 `evaluateDataAvailabilityPolicy()`，`workflowPhaseFilter` 和 Worker resume directive 共用同一份判断；策略已兼容 `data-source-discovery-report`，不再只把 `data-hub-import-proposal` 当作发现证据。
- **进展补充**：2026-06-11 已新增 `DataSourceProvider` registry，Data Hub 是默认 provider，`evaluateDataAvailabilityPolicy()` 可注入其他 provider 并按 provider 的 discovery tool / artifact types 判断下一步和满足条件。
- **剩余问题**：当前实际注册的可执行 provider 工具仍只有 `discover_data_hub_candidates`；尚未实现第二个真实 provider，也还没有通用 `discover_data_source_candidates` 工具。
- **建议**：继续扩展通用 `dataAvailabilityPolicy`：
  - 输入：scene facts、model schema、required slots、已查询 source providers。
  - 输出：allowed next tool set 和 required next action。
  - Data Hub 只是 `sourceProvider: data-hub` 的一个实现。
- **优先级**：P0，第一阶段已完成；剩余是真实多 provider 工具和通用 discovery report 生产。

### 3.2 Worker direct execution 特判导入工具

- **位置**：`agent/src/worker/InvestAgentWorker.ts`
- **当前行为**：`approvedConfirmationForDirectExecution` 只识别 `import_data_hub_files_to_scene`，批准后 Worker 先直接执行该工具。
- **为什么需要**：用户确认导入后，不能等模型再次“决定是否导入”；导入必须先发生。
- **问题**：这个能力本质是“确认后自动执行原工具输入”，不应该只服务一个工具。
- **进展**：2026-06-11 已完成第一步，Worker 改为读取 `AgentTool.policy.confirmation.approvedAction === "execute-approved-input"`，Data Hub import 工具通过 policy 声明原有行为。
- **进展补充**：`AgentTool.policy.mutation.refreshesArtifacts` 已加入核心类型，Data Hub import 工具声明会刷新 `gsms-scene-data-cards` 和 `data-card`，`workflowPhaseFilter` 已根据该 contract 阻止 mutation 后未刷新事实就 finish；对应行为由测试覆盖。
- **建议**：给 tool 增加声明式 metadata：
  - `confirmation.mode: "defer-and-resume" | "direct-execute-approved-input"`
  - `confirmation.resumeInstruction`
  - `mutation.refreshFacts`
  Worker 根据 metadata 处理所有符合条件的工具。
- **优先级**：P0，剩余工作是继续抽象 resume instruction 和 mutation record schema。

### 3.3 Worker resume directive 是自然语言 if-else

- **位置**：`agent/src/worker/InvestAgentWorker.ts`
- **当前行为**：`workflowDirective()` 根据 phase、artifact counts 返回硬编码自然语言。
- **为什么需要**：降低模型续跑时重复旧阶段或走错工具的概率。
- **问题**：新增 phase、artifact 或工具后容易漏改；自然语言 directive 和工具可见性 gate 可能不一致。
- **建议**：引入 `workflowPolicy`：
  - 每个 phase 声明 `requiredEvidence`、`blockedTools`、`preferredNextTools`、`resumeInstruction`。
  - `workflowPhaseFilter` 和 `buildWorkflowResumeContext` 读取同一份 policy。
- **优先级**：P1。

### 3.4 前端 Data Hub import payload 专门解析

- **位置**：`frontend/pages/workbench/[sceneId].tsx`
- **当前行为**：确认 payload 已支持通用 `ui.type === "data-import-proposal"` contract，Workbench 优先按该 UI contract 渲染推荐导入卡；旧的 `kind === "import_data_hub_files_to_scene"` payload 解析保留为历史 session fallback。
- **为什么需要**：快速做出“推荐导入”确认卡，展示 slot、文件、置信度、原因。
- **进展**：2026-06-11 已完成第一步，`AgentTool.policy.confirmation.ui()` 可生成 confirmation UI 描述，Data Hub import 工具产出 `data-import-proposal`，前端解析逻辑已抽到 `frontend/src/lib/confirmationPayload.ts` 并由单测覆盖。
- **剩余问题**：后端/Agent confirmation UI schema 尚未固化为共享类型包；前端仍保留旧 fallback 兼容路径。
- **建议**：后端/Agent confirmation payload 统一带 `ui` 描述：
  - `ui.type: "data-import-proposal" | "generic-confirmation"`
  - `ui.rows`、`ui.actions`、`ui.statusLabels`
  前端只按 `ui.type` 渲染，不解析工具私有 input。
- **优先级**：P1，第一阶段已完成。

### 3.5 Tool label 和 activity block 仍有工具名映射

- **位置**：Workbench `TOOL_LABEL`、activity timeline。
- **当前行为**：新增工具需要手动补中文 label。
- **为什么需要**：让思考过程对用户可读。
- **问题**：UI 文案和工具注册分离，容易漏。
- **建议**：工具声明里提供 `displayName`、`activityVerb`、`category`，前端优先使用事件里的显示信息，缺失时再 fallback 到工具名。
- **优先级**：P2。

### 3.6 Slot alias 兼容属于补洞逻辑

- **位置**：matching tools slot canonicalization。
- **当前行为**：兼容 `*_asset_id` / `*_id` 到 schema `*_path`。
- **为什么需要**：模型曾反复发明错误 slot 名，导致工具失败。
- **问题**：alias 规则如果继续扩散，会掩盖 schema contract 不清晰的问题。
- **建议**：短期保留兼容；长期通过 tool schema、skill examples、error recovery 收敛，让模型只使用 schema slot name。
- **优先级**：P2。

### 3.7 Data Hub discovery artifact 兼具证据和 UI proposal

- **位置**：Data Hub discovery tool / frontend confirmation card。
- **当前行为**：Data Hub discovery 已同时产出通用 `data-source-discovery-report`（证据层）、通用 `confirmation-proposal`（用户动作 proposal）和旧 `data-hub-import-proposal`（兼容层）。`data-source-discovery-report` metadata 带 `providerId: "data-hub"`，供 data availability policy 识别。
- **为什么需要**：减少接口数量，快速把 discovery 结果连到用户确认。
- **进展**：2026-06-11 已完成第二步，证据层和用户动作 proposal 层已拆分；`import_data_hub_files_to_scene` 优先读取通用 `confirmation-proposal` 校验可导入文件，旧 proposal 保留为 fallback，避免破坏历史 session。
- **剩余问题**：`confirmation-proposal` schema 尚未共享类型化，前端确认 payload 仍通过 `payload.ui` 直接传递而不是引用 proposal artifact。
- **建议**：拆分语义：
  - 已有 `data-source-discovery-report`：候选与缺口证据。
  - 已有 `confirmation-proposal`：面向用户确认的 UI/动作摘要。
- **优先级**：P1，第二阶段已完成；剩余是 schema 共享和前端引用式消费。

---

## 4. 推荐重构路线

### v1：收敛硬编码，不改变行为

目标是把当前可工作的规则集中到声明式 policy，避免继续散落。

- 已新增 `AgentTool.policy.confirmation` 和 `AgentTool.policy.mutation`，描述确认后动作、确认摘要、成功续跑消息、刷新 artifact contract。
- 已把 Worker 中 `approvedConfirmationForDirectExecution` 的工具名白名单改为读取 tool policy。
- 已把 `permissionPayloadSummary()` 改为调用工具提供的 confirmation summary。
- 已把空场景 external discovery 判断集中到 `evaluateDataAvailabilityPolicy()`，供 directive/filter 共用。
- 待继续把完整 `workflowDirective()` 和 `workflowPhaseFilter()` 迁到同一份 workflow policy 数据。
- 保留当前所有用户可见行为和测试。

### v2：抽象 Data Hub-first 为数据可用性策略

目标是摆脱“空场景只认识 Data Hub”的具体规则。

- 引入 `dataSourceProvider` 概念，Data Hub 是第一个 provider。
- 已引入 `dataSourceProvider` registry，Data Hub 是第一个 provider。
- 已将 empty-scene 判断改为 `dataAvailabilityPolicy.requiresExternalDiscovery(...)`。
- 已新增通用 discovery artifact 层 `data-source-discovery-report`，并保留旧 `data-hub-import-proposal` 兼容。
- `assess_scene_model_readiness` 对单模型空场景不再作为绕过 discovery 的路径。

### v3：前端确认 UI contract 化

目标是让前端不解析具体工具 input。

- 已为 confirmation payload 增加 `ui` 字段，前端按 `ui.type` 渲染 `data-import-proposal`。
- `AgentConfirmationCard` 拆出通用确认卡和 Data Import Proposal 卡。
- timeline projection 保持只识别 `confirmation` block，不识别具体工具名。
- Data Hub import 的 slot/file/reason/risk 已通过 `ui.rows` 进入前端；旧 payload fallback 暂时保留。

### v4：清理兼容和重复提示

目标是减少历史补丁痕迹。

- 梳理并减少 slot alias 兼容范围，保留明确 telemetry 或测试。
- Skill 中删除和 tool policy 重复的强指令，只保留人类可读 procedure。
- 移除重复的 hardcoded resume 文案，把文案集中到 policy。

---

## 5. 测试与验收建议

后续重构必须保留以下回归场景：

- 空场景问“Carbon 能不能跑”：必须先 Data Hub discovery，不能直接 sufficiency/readiness/finalize。
- Data Hub 有候选：必须展示确认 proposal，用户确认前不得写入 scene imports。
- 用户确认导入：Worker 必须先执行批准的原始工具输入，再继续匹配。
- 导入后：必须刷新 scene data cards，后续 candidate retrieval 只能基于刷新后的数据。
- confirmation UI：确认前后保持同一张思考卡，不额外生成 AI 气泡。
- 多工具扩展：新增一个需要 direct-execute 的写工具时，不改 Worker 工具名白名单即可工作。
- 前端扩展：新增一种 confirmation UI 时，不需要在 Workbench 解析具体工具 input。

验收标准：

- 现有 Carbon/Data Hub 用户流程行为不变。
- 现有 agent/frontend 相关测试全部通过。
- 新增 policy 单测覆盖至少两个不同工具，证明不再只支持 `import_data_hub_files_to_scene`。
- 文档中 P0/P1/P2 项能逐项对应到 issue 或后续实现任务。

---

## 6. 优先级总览

| 优先级 | 项目 | 理由 |
| --- | --- | --- |
| P0 | 导入后刷新事实 contract | 第一阶段已完成；剩余是固化 mutation record schema |
| P0 | direct execution 从工具名白名单改为 policy | 第一阶段已完成；剩余是补全 resume policy |
| P0 | empty-scene discovery gate 抽象 | 第一阶段已完成；provider registry 已落地，剩余是真实多 provider 工具和通用 discovery report 生产 |
| P1 | workflow directive/filter 共享 policy | 避免提示和工具可见性不一致 |
| P1 | confirmation payload UI contract | 第一阶段已完成；剩余是共享 schema 和组件拆分 |
| P1 | discovery report 与 confirmation proposal 拆分 | 第二阶段已完成；剩余是 schema 共享和前端引用式消费 |
| P2 | tool label metadata | 降低 UI label 映射维护成本 |
| P2 | slot alias 兼容收敛 | 减少补洞式容错 |

---

## 7. 默认假设

- 当前 Carbon/Data Hub 流程是正确基线，后续重构不得回退体验。
- 先做渐进抽象，不重写 Agent runtime。
- Data Hub 是第一个外部数据源 provider，但不是长期唯一 provider。
- 前端应以 confirmation/event contract 为边界，不直接依赖 Agent 工具私有 input。
- Skills 负责指导调查方法，Gates/Policies 负责不可绕过的协议。
