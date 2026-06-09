# 智能体能力改进计划

**日期：** 2026-06-09
**背景：** 用户反馈"智能体不够聪明"——同一问题（"查看当前场景数据并判断可运行哪些模型"）三次回答步数差异巨大（3 步 / 15 步 / 12 步），且存在大量冗余工具调用与啰嗦叙述。本文档定位根因并给出分档改进计划。

> 注：前端"思考文字重复 20+ 遍"是另一个独立问题，根因是多个并发轮询循环重复折叠同一批 `model.streaming` 事件，已于同日修复（单一自调度轮询 + 重入锁）。本文档只讨论**智能体本身**的能力问题。

---

## 一、诊断

### 1.1 核心病灶：`matchingContextId` 抖动

**位置：** `agent/src/tools/gsmsTools.ts:225`、`agent/src/tools/matchingTools.ts:34`

**机制：**

```text
matchingContextId = hash(sceneId + 模型 schema + 数据卡指纹)
```

- 数据卡（`data-card`）artifact 用 `matchingContextId` 打标签（`gsmsTools.ts:242`）。
- `retrieve_input_candidates` 只读取**当前 `matchingContextId` 的**数据卡（`matchingTools.ts:30-36`）。
- 一旦 `get_invest_model_schema` 切换到另一个模型 → schema 变化 → `matchingContextId` 的 hash 变化（`gsmsTools.ts:173`）→ 旧数据卡被 context 过滤掉 → `retrieve_input_candidates` 返回 **0 候选**。

**后果：** 智能体把"0 候选"理解为"上下文丢失"，于是重新 `list_scene_data_cards` + 重新 `get_invest_model_schema`，陷入"切模型 → 候选归零 → 重载 → 再切"的来回拉扯。这正是日志中反复出现的：

> "retrieve 返回空 → 需要先切换到 habitat_quality 模型 → 让我重新获取其 schema 后再试"

**设计层面的错误归属：** 数据卡描述的是**场景文件的客观事实**（文件名、类型、字段、坐标系），这与"当前选了哪个模型"无关。把数据卡和模型 schema 绑进同一个 context id，是不必要的耦合。

### 1.2 放大病灶：多模型普查不是一等操作

**位置：** `agent/skills/data-matching/SKILL.md:26-35`、`agent/src/worker/InvestAgentWorker.ts` → `workflowDirective()`

- skill 的 Mode A 是**单模型**视角（"the target model"），没有"遍历所有模型做充分性判定"的标准流程。
- 多模型普查只能靠 LLM 自己循环；而每次 `get_invest_model_schema` 都会重置 `phase: 'discovering-data'` + `slots: null` + 重算 `matchingContextId`（`gsmsTools.ts:193-206`）——等于每切换一个模型就自毁一次匹配进度。
- `workflowDirective` 返回的续作指令也全是单模型假设，无法引导"对 N 个模型分别评估"。

**后果：** "哪些模型能跑"这种**本质上要扫描多个模型**的问题，被迫在一个对单模型优化的工作流里反复横跳，步数线性膨胀且不稳定。

### 1.3 附带病灶：输出啰嗦

**位置：** system prompt 与 skill 均无简洁性约束。

- 模型在每两次工具调用之间产出长段叙述性"思考"，且常把最终结论的草稿提前写进中间文字。
- `finalize_sufficiency_assessment` 已生成确定性 `summary`（`gsmsTools.ts:811-815`），但 `finish` 未复用它，导致 LLM 重新自由发挥一遍。

---

## 二、改进计划（按性价比分档）

### P0-A：消除 context 抖动（止血，单点核心改动）

**目标：** 让数据卡与模型解耦，切模型不再清空候选。

**方案：**

1. 数据卡 artifact 改用与模型无关的上下文标识：

   ```text
   sceneDataContextId = hash(sceneId + 排序后的资产指纹)
   ```

   不含模型 schema。

2. `retrieve_input_candidates` / `retrieve_required_input_candidates` 按 `sceneDataContextId` 取数据卡，而非 `matchingContextId`。
3. `matchingContextId`（仍含模型）只保留给**真正与模型绑定**的证据：`binding-report`、`validation-report`、`candidate-set`。候选集仍按模型隔离是正确的——它是"某模型某槽位"的匹配结果；但它读取的**输入数据卡**应来自场景级上下文。
4. `get_invest_model_schema` 切模型时，不再因 schema 变化而使数据卡失效。

**验收：**

- 同一场景内连续 `get_invest_model_schema(A)` → `get_invest_model_schema(B)` 后，`retrieve_input_candidates` 仍能基于已加载的数据卡返回候选，无需重新 `list_scene_data_cards`。
- 新增回归测试：切模型后候选不归零。

**影响面：** 集中在 `gsmsTools.ts` 与 `matchingTools.ts` 的 context 计算与过滤；不触碰 `packages/agent-core`。

### P0-B：多模型普查作为一等工具

**目标：** 把"哪些模型能跑"从"LLM 循环 N 个模型、切 N 次 schema"变成一次确定性工具调用。

**方案：**

新增后端确定性工具 `assess_scene_runnable_models`：

- 输入：`sceneId`。
- 内部：对所有已注册模型，逐一加载 schema、对每个必需槽位做数据充分性匹配、检查 runner 可用性。
- 输出：per-model 的 `{ runnable, runnerAvailable, slots: [{ slot, status: available|missing|ambiguous, evidence }] }`。
- 产出 `scene-runnable-assessment` artifact 作为可审计证据。

skill Mode A 增加分支：当用户问"哪些模型能跑"时，**优先调用 `assess_scene_runnable_models`**，而非逐模型循环。

**验收：**

- "查看当前场景数据并判断可运行哪些模型" → 2-3 步完成（`list_scene_data_cards` + `assess_scene_runnable_models` + `finish`），步数不再随模型数量线性增长。
- 结果确定、可复现，符合 `evidence-gated-agent-development-plan.md` Phase 2 的 `DataSufficiencyGate` 方向。

**与现有计划的关系：** 这是 Phase 2 `DataSufficiencyGate` / `RunnableGate` 的具体落地，区分 `data_sufficient` 与 `runnable` 两个结论。

### P1：抑制啰嗦

**目标：** 思考紧凑、答案直给。

**方案：**

1. 在 system prompt 与 skill 中加入明确约束：工具调用之间的思考 ≤ 1 句；不在中间文字里草拟最终答案。
2. `finish` 复用 `finalize_sufficiency_assessment` / 报告工具已生成的确定性 `summary`，减少 LLM 重写。

**验收：** 思考时间线步骤数显著下降；中间文字不再出现与最终答案重复的大段内容。

### P2：偿还结构性技术债（已在 `tech-debt.md` 记录）

**目标：** 让"多模型 / 新模型"可扩展，根除硬编码。

**方案：** 将以下硬编码 if-else 改为 phase/工具自带属性的声明式配置：

- `workflowDirective`（`tech-debt.md` 第 1 条）— phase → 指令映射。
- `executionPhaseAllows`（第 2 条）— phase → 工具白名单。
- `phaseGroupMap`（第 6 条）— phase → group 映射。
- `WAITING_PHASES`（第 4 条）— 用 phase 的 `persistAcrossRuns` 属性替代硬编码集合。

**说明：** 这是长期可维护性的根本，但**不阻塞 P0**。建议在 P0 验证有效后再推进。

---

## 三、交付顺序

| 优先级 | 交付项 | 阻塞关系 |
| --- | --- | --- |
| P0 | P0-A 数据卡 context 解耦 + 切模型回归测试 | 无 |
| P0 | P0-B `assess_scene_runnable_models` 工具 + skill Mode A 分支 | 可与 P0-A 并行 |
| P1 | 简洁性约束 + `finish` 复用确定性 summary | 建议 P0 后 |
| P2 | 声明式 phase 配置（偿还债务 1/2/4/6） | P0 验证后 |

## 四、直接下一步

落地两个 P0：

> 数据卡与模型解耦（消除 `matchingContextId` 抖动），并将多模型充分性普查实现为单次确定性工具调用。两者直接消除用户观察到的"步数膨胀 + 反复重载"症状，改动集中、可测，且不触碰 `packages/agent-core`。

---

*本文档与 `tech-debt.md`、`evidence-gated-agent-development-plan.md` 配套阅读。每完成一档，标注完成时间与实际方案。*
