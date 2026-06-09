# 智能体设计审阅：GSMS vs. Claude Code 成熟实现

**日期：** 2026-06-09
**目的：** 将 GSMS Agent 的设计与 `/home/Claude-Code`（Claude Code 真实源码）的成熟设计对比，识别应当吸纳的设计。
**范围说明：** 按要求忽略 `clean-room-agent`、`clean-room-skills` 与 `invest-agent` 三个目录，只参考 Claude Code 主体源码（`src/`、`docs/`）。

> 重要边界：Claude Code 是**通用交互式编码 Agent**，GSMS 是**领域化、证据门控的科学计算 Agent**。不能整体照搬——GSMS 的 Gate / Workflow Boundary / 确定性后端计算是 Claude Code 没有的、且必须保留的核心价值。本文只挑选**与 GSMS 当前痛点对应、且不破坏证据门控架构**的设计。

---

## 一、对比维度总览

| 维度 | Claude Code 的做法 | GSMS 现状 | 差距严重度 |
| --- | --- | --- | --- |
| 工具暴露 | 工具**延迟加载**（defer），用 ToolSearch 按需取 schema | 全部工具一次性进 system prompt | 中（GSMS 工具少，暂不痛） |
| 工具接口 | 统一 `Tool` 契约，含 `isReadOnly`/`isConcurrencySafe`/`getActivityDescription`/`renderToolResult` 等丰富元数据 | `AgentTool` 接口较薄，无活动描述、无结果渲染元数据 | 中 |
| 技能发现 | frontmatter `description` + `when_to_use`，**渐进式披露**，列表只占 1% 上下文，正文调用时才加载 | skill 全文进 `formatForModel()`，无 `when_to_use` 字段 | **高** |
| 简洁性控制 | Brief 工具 + 文本可见性契约；输出风格明确约束 | 无任何简洁约束 | **高** |
| 轮次预算 | `tokenBudget` 显式跟踪、递减收益检测（diminishing returns）自动停 | 仅 `maxTurns` 硬上限，无收益检测 | **高** |
| 上下文管理 | 自动压缩（autocompact）+ 微压缩 + 工具结果落盘（`maxResultSizeChars`） | 无压缩；工具结果全量进 messages | 中 |
| 子代理 | AgentTool 派生隔离子代理，保护主上下文 | 无子代理机制 | 低（GSMS 单一工作流） |
| 工具结果落盘 | 超过 `maxResultSizeChars` 自动落盘，模型只收预览+路径 | 全量 JSON 进 content | 中 |
| 工具默认值 | `buildTool` 统一填充安全默认（fail-closed） | 每个工具手写完整定义 | 低 |

---

## 二、应当吸纳的设计（按性价比排序）

### A. 渐进式技能披露（Progressive Skill Disclosure）— **最高优先**

**Claude Code 的做法**（`src/skills/loadSkillsDir.ts`、`src/tools/SkillTool/prompt.ts`）：

- 技能 frontmatter 含三个发现字段：`name` / `description` / `when_to_use`。
- system prompt 里**只放摘要列表**（`name + description - whenToUse`），且整个列表**硬限制在上下文的 1%**（`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`），单条上限 250 字符。
- 技能**正文只在 `Skill` 工具被调用时才加载**——`estimateSkillFrontmatterTokens` 注释明说："full content is only loaded on invocation"。
- 预算超限时按优先级截断描述，bundled 技能永不截断。

**GSMS 现状**（`buildSystemPrompt.ts` + `SKILL.md`）：

- `skills.formatForModel()` 把技能信息整体塞进 system prompt。
- `SKILL.md` 没有 `when_to_use` 字段，Mode A/Mode B 的完整流程**常驻** system prompt。
- 没有"摘要列表 → 按需加载正文"的两段式。

**为什么这对 GSMS 重要：**
1. GSMS 的痛点之一是"多模型普查时反复横跳"——部分原因是模型一直被完整流程文本牵引。把详细流程移到**调用时加载**，能让 system prompt 更聚焦于"何时用哪个技能"。
2. 当 GSMS 增加更多 InVEST 模型（Habitat / Water Yield / SDR）时，每个模型的匹配指引都常驻 prompt 会迅速膨胀。渐进式披露是可扩展性的前提。

**吸纳建议：**
- 给 `SKILL.md` frontmatter 增加 `when_to_use` 字段。
- `skills-core` 区分"摘要列表（常驻）"与"正文（`skill` 工具调用时注入）"两段。
- system prompt 只放摘要，给技能列表设字符预算上限。

### B. 显式轮次/收益预算（Diminishing-Returns Stop）— **高优先**

**Claude Code 的做法**（`src/query/tokenBudget.ts`）：

- 不只看硬上限，而是跟踪**每次续作的 token 增量**。
- `isDiminishing`：连续 ≥3 次续作、且增量低于阈值（500 token）→ 判定"收益递减"→ 主动停止。
- 既防止过早停（还有产出就继续），也防止空转（产出停滞就收尾）。

**GSMS 现状**（`AgentRuntime.ts`）：

- 只有 `maxTurns`（默认 30）硬上限。
- 你贴的那轮 15 步里，后半段全是重复的 `retrieve` 归零 + 重载——**纯空转**，但因为没到 `maxTurns`，运行时不会干预。

**吸纳建议：**
- 在 `AgentRuntime` 的主循环里加"无新证据/无新 artifact 的连续轮次计数"。连续 N 轮没有产生新 artifact 或新 domain 状态变化 → 注入一条 steering 消息（"你在重复，请直接 finish 或换策略"），再连续则强制收尾。
- 这是对 GSMS"空转 thrash"最直接的运行时止血，且与证据门控天然契合（证据 = artifact，递减 = 没有新 artifact）。

### C. 简洁性 / 文本可见性契约 — **高优先**

**Claude Code 的做法**：

- 有专门的输出风格契约（Brief 工具的"text-visibility contract"），明确"工具调用旁白≤1 句、不在中间文字里草拟最终答案"。
- `getActivityDescription` 让每个工具自报一句话现在时活动描述（"Reading src/foo.ts"），UI 显示这句而非让模型自由发挥旁白。

**GSMS 现状：**

- `buildSystemPrompt` 的 Rules 里**没有任何简洁约束**。
- 工具无"活动描述"元数据，思考时间线里的旁白完全靠模型即兴，导致啰嗦 + 把最终答案草稿提前写进中间文字（前端"答案先于卡片出现"问题的根源之一）。

**吸纳建议：**
- system prompt Rules 增加简洁契约：工具调用之间最多一句话；不在中间叙述里草拟最终答案；最终答案直接给结论。
- 给 `AgentTool` 接口加可选 `getActivityDescription(input)`，时间线步骤标题用它，减少对模型自由旁白的依赖。

### D. 工具结果落盘 / 上下文压缩 — **中优先**

**Claude Code 的做法**（`Tool.ts` 的 `maxResultSizeChars`）：

- 每个工具声明结果大小上限，超限自动落盘，模型只收"预览 + 文件路径"。
- 配合 autocompact / microcompact 在上下文逼近上限时压缩历史。

**GSMS 现状：**

- 工具结果（如 `list_scene_data_cards` 的完整 JSON、schema 全文）**全量进 messages**。
- 多轮普查时这些大 JSON 累积，挤占上下文、抬高每轮成本。

**吸纳建议：**
- 给 `AgentTool` 结果加大小阈值：大结果存为 artifact，content 只回"摘要 + artifact 引用"。这与 GSMS 既有的 artifact 体系完全对齐——artifact 本就是证据存储，正好兼做"落盘的工具结果"。

### E. 更丰富的工具元数据契约 — **中优先**

**Claude Code 的 `Tool` 接口**提供：`isReadOnly` / `isConcurrencySafe` / `isDestructive` / `getActivityDescription` / `searchHint` / `maxResultSizeChars`，并用 `buildTool` 统一填充 fail-closed 默认值。

**吸纳建议：**
- GSMS 的 `risk: 'read'|'control'` 偏粗。可借鉴细分元数据（只读/可并发/破坏性），为将来"并行检索多个模型候选"（多模型普查的并发优化）打基础。
- 引入类似 `buildTool` 的工厂，集中安全默认，减少每个工具的样板。

---

## 三、明确不吸纳 / 谨慎吸纳的设计

| 设计 | 为何不照搬 |
| --- | --- |
| ToolSearch 延迟加载 | GSMS 目前工具数量少（~15 个），延迟加载的收益 < 复杂度。**记为未来项**，等工具数显著增长再做。 |
| 通用权限/hook 系统 | Claude Code 的权限系统服务于通用文件/shell 操作；GSMS 的 PermissionManager + 确认流程已贴合领域，不需要泛化。 |
| 自由 REPL / Bash 工具 | 与 GSMS"所有科学计算走确定性后端"的核心原则冲突，绝不能引入。 |

### 子代理（AgentTool 派生）— 限定为"只读侦察兵"，而非工作流执行者

子代理需要单列，因为它常被误当作"端到端自动化"的手段。这里给出明确定位。

**先纠正一个常见误解：** "用户给一句模糊的自然语言指令，Agent 全做完"——这个目标主要靠**自主链式推进 + 恢复能力**实现，**不是靠子代理**。两者正交。

GSMS 的工作流是**严格顺序、有状态、含人类确认**的：

```text
发现数据 → 匹配 → 验证 → [用户确认] → 执行(不可逆) → 分析 → 报告
```

每一步依赖前一步的 artifact 与 gate 状态。子代理擅长的恰恰相反——**独立、可并行、无共享状态**的任务。把这条线性管道拆给子代理会直接破坏 GSMS 的核心：

- **割裂证据链**：GSMS 的核心价值是单一、可审计的 artifact 存储 + gate 校验。子代理在隔离上下文里产生的 artifact 与 `matchingContextId` 无法干净地合并回主代理的 gate。
- **跨不了确认边界**：执行前的人类确认必须发生在主对话里，子代理无法代行不可逆决策。

因此"一句话全做完"该投资的是**更强的自主链式推进**（更好的 resume 指令、收益递减自动停 / 见本审阅 B）+ 让现有 phase/gate 机制能在无人干预下走完。这些已在 P0/P1 规划中，与子代理无关。

**子代理在 GSMS 唯一有价值的场景：保护主上下文的只读侦察。**

例如"普查所有模型能否运行"或"清点场景全部数据并汇总"：让子代理去读大量栅格元数据 / CSV schema，只把**压缩后的结构化摘要**返回主代理，大 JSON 不进主上下文（与本审阅 D"工具结果落盘"同一动机）。

引入时必须遵守两条硬约束：

1. **子代理只能当侦察兵，不能当行动者**——绝不做 gated 或不可逆决策，只返回证据；所有 gate / 确认 / 执行仍在主代理。
2. **确定性侦察优先用确定性工具，而非子代理**——多模型充分性普查这类确定性任务，用 `assess_scene_runnable_models`（改进计划 P0-B）即可，确定、可审计、便宜。子代理只在调查**本质上需要 LLM 判断且产出量大**时才划算。

**定位一句话：** 子代理 = "保护上下文的只读侦察兵"，不是"工作流的执行者"。优先级 **P2/P3**——端到端自动化先靠自主性 + gate 走通（P0/P1），子代理作为上下文经济学的后续优化再引入。

---

## 四、与既有改进计划的关系

本审阅与 `agent-intelligence-improvement-plan.md` 互补，可合并优先级：

| 来源 | 改进项 | 合并优先级 |
| --- | --- | --- |
| 改进计划 P0-A | 数据卡 context 解耦（消除 `matchingContextId` 抖动） | **P0** |
| 改进计划 P0-B | `assess_scene_runnable_models` 多模型普查工具 | **P0** |
| 本审阅 B | 收益递减自动停（运行时止血空转） | **P0**（与 P0-A/B 并列，改动小） |
| 本审阅 C | 简洁性契约 + 工具活动描述 | **P1** |
| 本审阅 A | 渐进式技能披露 + `when_to_use` | **P1** |
| 本审阅 D | 工具结果落盘到 artifact | **P2** |
| 本审阅 E | 工具元数据细分 + buildTool 工厂 | **P2** |
| 本审阅"子代理" | 只读侦察子代理（仅返回证据，不做 gated 决策） | **P2/P3**（确定性侦察优先用工具） |
| 本审阅"未来项" | ToolSearch 延迟加载 | **P3**（工具数增长后） |

---

## 五、一句话结论

GSMS 的**证据门控 + 确定性计算**架构是 Claude Code 所没有的、且更适合科学场景的核心优势，应当保留。最值得吸纳的是 Claude Code 在**"上下文经济学"**上的成熟做法——**渐进式技能披露**（A）、**收益递减自动停**（B）、**简洁性契约**（C）、**工具结果落盘**（D）。这四项直接对症 GSMS 当前"啰嗦 + 空转 + 上下文膨胀"的症状，且都能在不破坏证据门控的前提下落地。

---

*本文档与 `agent-intelligence-improvement-plan.md`、`tech-debt.md`、`evidence-gated-agent-development-plan.md` 配套阅读。*
