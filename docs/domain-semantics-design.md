# 领域语义收紧设计：问题 5/6/7

> 对应 `docs/suggestion0609.md` 阶段三。问题 1-4 已在分支 `fix/runtime-execution-contract` 修复完毕。

## 背景

三个问题的共同本质是**语义过度声明**——工具或字段宣称了它们无权证明的东西。

| # | 问题 | 核心漏洞 |
|---|------|---------|
| 5 | `userConfirmed: true` 可被模型自行填写 | 无用户真实选择的证据 |
| 6 | `assess_scene_runnable_models` 把"数据存在"当作"可运行" | 跳过了关系校验、官方 validation、用户确认 |
| 7 | `run_reconnaissance` 子代理把 LLM 文本当"证据" | 子代理 artifacts 被丢弃，只留文本 findings |

### 核心安全发现（问题 5 的基础）

全代码库只有一处合法设置 `createdBy: 'user'`：`confirm_validation_snapshot`（`gsmsTools.ts:528`）。
它可信，**仅因为**它是 `risk:'write'`，执行必须经过 worker 的 `#approveOrDefer` 确认流程
（`InvestAgentWorker.ts:222-251`）。

但 `ArtifactStore.createMany`（`packages/agent-core`）**逐字复制 `createdBy`，无任何强制**
——任何模型调用的工具都能伪造 `createdBy:'user'`。`AgentContext` 也不向工具暴露 confirmation API。

结论：问题 5 必须既"让 gate 不信任模型 boolean"，又"堵住 `createdBy:'user'` 伪造口"。

---

## 问题 6：`assess_scene_runnable_models` 重命名 + 分级就绪语义

### 现状

`gsmsTools.ts:951`：`runnable = dataSufficient && runnerAvailable`。
只检查每个必填槽是否有 ≥1 候选数据 + runner 是否可用。没有跨文件关系校验、官方 InVEST
validation、用户确认。`runnable` 这个词承诺了太多。

### 设计

**工具重命名**：`assess_scene_runnable_models` → `assess_scene_model_readiness`。

**artifact type 重命名**：`scene-runnable-assessment` → `scene-model-readiness`。

**输出分级替代布尔值**：定义完整就绪阶梯，但本工具只能断言到 `preliminary_data_sufficient`：

```
type ReadinessLevel =
  | 'runner_available'             // runner 存在但数据不足
  | 'preliminary_data_sufficient' // 每个必填槽 ≥1 候选（本工具上限）
  | 'ready_for_validation'        // 关系检查通过（本工具不可断言）
  | 'validated'                   // 官方 InVEST validation（不可）
  | 'confirmed'                   // 用户确认（不可）
  | 'runnable_now'                // confirmed + runner（不可）
```

计算规则：
- 无 runner → `runner_available:false`（不输出 readinessLevel）
- 有 runner + 数据不足 → `readinessLevel: 'runner_available'`
- 有 runner + 每个必填槽 ≥1 候选 → `readinessLevel: 'preliminary_data_sufficient'`
- **绝不输出 `ready_for_validation` 及以上**

输出 `runnableModels` → `preliminaryReadyModels`。summary 文案 "runnable" → "preliminarily data-sufficient"。

### 引用更新

| 文件 | 位置 | 改动 |
|------|------|------|
| `agent/src/tools/gsmsTools.ts:862-970` | 工具定义 | 重命名 + 输出重构 |
| `agent/src/workflowBoundary.ts:111` | `matchingTools` set | 重命名 |
| `agent/src/workflowBoundary.ts:~214` | `finishPassesEvidenceGate` | artifact type 重命名 |
| `agent/skills/data-matching/SKILL.md` | allowed-tools + 多模型步骤 | 重命名 |
| `agent/src/domain/schemas.ts` | 可选 | 加 `ReadinessLevel` 类型 |

**无后端改动。**

### 测试

- 必填槽都有候选 + runner 可用 → `readinessLevel === 'preliminary_data_sufficient'`，
  且断言**绝不**返回 ≥ `ready_for_validation` 的级别。
- runner 缺失 → 级别非 `preliminary_data_sufficient`。
- `finishPassesEvidenceGate` 在存在 `scene-model-readiness` artifact 时仍返回 true。

---

## 问题 7：`run_reconnaissance` 放到实验开关后 + 结构化未验证证据

### 现状

`reconTools.ts:132-153`：子代理运行在隔离的 `ArtifactStore` 上，完成后只返回
`{findings, turnsUsed, status, diagnostics}`——一段 LLM 文本。内部 artifacts 被丢弃，
父 Agent 无法引用为确定性证据。

### 设计

#### Part 1：实验开关

新增环境变量 `INVEST_AGENT_EXPERIMENTAL_RECON`。

| 注册点 | 文件 | 改动 |
|--------|------|------|
| Worker | `InvestAgentWorker.ts:135-138` | `if (options.experimentalRecon)` 才 push recon tool |
| Worker options | `InvestAgentWorker.ts:29-37` | 加 `experimentalRecon?: boolean` |
| Worker 入口 | `worker.ts` | 从 `process.env` 读取传入 |
| CLI | `cli.ts:68-72` | 同样 gating |
| CLI config | `cli/config.ts` | 加 `experimentalRecon` 字段读 env |

`workflowBoundary.ts:112` 保留 `run_reconnaissance` 在 set 中（未注册的工具不会被 filter 影响）。

#### Part 2：结构化未验证证据

子代理的 `result.artifacts` 作为**显式未验证**的结构化数据放进工具返回的 `content`：

```json
{
  "findings": "...(现有)...",
  "turnsUsed": 5,
  "status": "completed",
  "diagnostics": [],
  "unverifiedEvidence": [
    { "type": "candidate-set", "data": {...}, "metadata": {...} }
  ],
  "verificationRequired": true,
  "note": "子代理结论未经验证。父 Agent 必须重新运行确定性工具（retrieve_input_candidates / check_data_relation / assess_scene_model_readiness）才能将任何结论转为父作用域证据。"
}
```

**关键约束**：recon 工具自身**不返回 `artifacts`**——子代理证据绝不进入父 `context.artifacts` /
Evidence Ledger。`unverifiedEvidence` 中只暴露 `type/data/metadata`，剥离 `createdBy`。

**无后端改动。**

### 测试

- 开关关闭 → 工具未注册。
- 开关开启 → 工具存在。
- 结构化返回：子代理产出 artifact → `content` 含 `unverifiedEvidence` + `verificationRequired:true`。
- **隔离回归（核心）**：执行后父 `ctx.artifacts.list()` 仍为空。
- 现有 recon 测试（只读过滤、finish summary、progress、lazy model）继续通过。

---

## 问题 5：`userConfirmed` 必须引用真实用户选择

### 方案选择：Option A（复用 defer/approve 通道）

**Option A**：复用已验证的 defer/approve 确认通道，新增 `record_user_disambiguation` 工具
产出 `createdBy:'user'` 的 `user-disambiguation` artifact；gate 只信任该 artifact，
不再信任模型 boolean。同时硬化 `createdBy:'user'` 防伪造。

**Option B**（弃用）：保留 `userConfirmed` 字段，gate 交叉校验 artifact。
仍需同样的用户选择 artifact，加脆弱的交叉校验，被 A 包含。

**选 A 的理由**：
1. 代码库唯一可信的 `createdBy:'user'` 路径就是"`risk:'write'` 工具经过 worker 确认流程"。
   Option A 直接复用。
2. 天然契合现有"needs_review → 用户决定 → re-finalize"循环
   （`data-matching/SKILL.md:55-60`，`BLOCKED_WHILE_AMBIGUOUS`，`workflowBoundary.ts:40-44`）。
3. 同时堵住两个漏洞：模型 boolean 欺骗 + `createdBy` 伪造。

### A. 新工具 `record_user_disambiguation`

新建 `agent/src/tools/disambiguationTools.ts`。

```typescript
{
  name: 'record_user_disambiguation',
  description: 'Record the user\'s explicit choice among tied candidates for a slot.',
  risk: 'write',  // 强制走 PermissionManager defer/approve
  inputSchema: {
    matchingContextId: string,  // 哪次匹配
    slot: string,               // 哪个槽位
    selectedAssetId: string,    // 用户选了哪个候选
  },
}
```

execute 流程：
1. 校验 `selectedAssetId` 在 `(matchingContextId, slot)` 的持久化 `candidate-set` 中。
   不在则抛 `toolFailure`。
2. 成功则产出 artifact：
   ```
   type: 'user-disambiguation'
   createdBy: 'user'    // 因 risk:'write'，worker 确认流程是唯一合法来源
   data: { matchingContextId, slot, selectedAssetId }
   metadata: { matchingContextId, slot, assetId: selectedAssetId }
   ```

因 `risk:'write'`，worker 暂停（`requestConfirmation`），仅在用户真实批准后才创建
——与 `confirm_validation_snapshot` 同生命周期。

### B. Gate 成为权威

`agent/src/gates/dataMatchingGate.ts:187`：

当前逻辑信任模型传入的 `binding.userConfirmed` boolean。
改为查询真实 artifact：

```typescript
// 加载当前 matchingContextId 下 createdBy === 'user' 的 user-disambiguation
const disambiguations = artifacts
  .list('user-disambiguation')
  .filter(a => a.metadata?.matchingContextId === matchingContextId && a.createdBy === 'user')
  .map(a => a.data)

const userChose = (slot: string, assetId: string) =>
  disambiguations.some(d => d.slot === slot && d.selectedAssetId === assetId)

// tie-break 守卫：触发除非用户真实选择过
if (isRequired && binding.status === 'matched' &&
    !(binding.selectedAssetId && userChose(binding.slot, binding.selectedAssetId)) &&
    hasTopScoreTie(candidateSet)) {
  // → needs_review
}
```

**`binding.userConfirmed` 不再被 gate 读取。**

### C. `finalize_data_matching` 镜像

`agent/src/tools/matchingTools.ts:274-289`：

`forcedAmbiguous` 条件从 `!decision.userConfirmed` 改为"无匹配的
`createdBy:'user'` disambiguation artifact"。加 helper `userDisambiguated(context, slot, assetId)`。

- 从输入 schema 删除 `userConfirmed`（line 212-215）——消除虚假可供性。
- binding 输出的 `userConfirmed`（line 299）改为从 disambiguation artifact 是否存在派生，
  保持 `bindingReportSchema`（`schemas.ts:120`）有效。
- `forcedAmbiguous` 时的 `agentReasoning` 提示改为
  "用户选择后调用 `record_user_disambiguation`"。

### D. 硬化 `createdBy:'user'` 防伪造（防御纵深）

**问题**：`StreamingToolExecutor.ts:352-353` 直接把 `result.artifacts` 传给
`ArtifactStore.createMany`，逐字复制 `createdBy`。任何模型调用的工具都能设 `createdBy:'user'`。

**方案**：在 executor 的 artifact 处理处加强制规则——

> 未经 defer→approve 权限循环的工具产出的 `createdBy:'user'` 一律改写为 `createdBy:'tool'`。

实现细节：
- executor 在 `toolGuard.check()` 返回时，若工具是 `risk:'write'|'execute'` 且返回 `'allow'`，
  标记该 tracked tool 为"经过权限检查"。
- 对于未标记的工具（read/control 自动放行，从未经过权限管理器），
  其 `result.artifacts` 中 `createdBy:'user'` 被降级为 `createdBy:'tool'`。
- 这同时保护 `confirmation-record` 与 `user-disambiguation`。

改动范围：`packages/agent-core/src/agent/StreamingToolExecutor.ts` artifact 处理块（~line 351-370）。

### 引用更新

| 文件 | 位置 | 改动 |
|------|------|------|
| `agent/src/tools/disambiguationTools.ts` | 新建 | 新工具定义 |
| `agent/src/gates/dataMatchingGate.ts:187` | tie-break 守卫 | 查 artifact 替代 boolean |
| `agent/src/tools/matchingTools.ts:274-301` | forcedAmbiguous + 输出 | 镜像 gate |
| `agent/src/tools/matchingTools.ts:212-215` | 输入 schema | 删除 `userConfirmed` |
| `agent/src/worker/InvestAgentWorker.ts:130-140` | 注册 | 注册新 write 工具 |
| `agent/src/cli.ts:63-72` | 注册 | 同上 |
| `agent/src/workflowBoundary.ts` | 工具集 | 加 `record_user_disambiguation`；豁免 `BLOCKED_WHILE_AMBIGUOUS`；`needs_review` 放行 |
| `agent/skills/data-matching/SKILL.md` | allowed-tools + 步骤 | 加工具 + "记录用户选择"步骤 |
| `agent/src/domain/schemas.ts` | 可选 | `userDisambiguationSchema` |
| `packages/agent-core/.../StreamingToolExecutor.ts` | artifact 处理 | `createdBy:'user'` 强制 |

**后端改动：无。** `record_user_disambiguation` 复用现有 confirmation 通道。

### 测试

| 测试 | 断言 |
|------|------|
| gate 忽略模型 boolean | tied report 设 `userConfirmed:true` 无 disambiguation artifact → `needs_review` |
| gate 信任真实选择 | `createdBy:'user'` disambiguation artifact → `ready_for_validation` |
| gate 拒绝伪造 | `createdBy:'tool'` disambiguation artifact → `needs_review` |
| finalize 强制 ambiguous | 输入声称 `userConfirmed`，无 disambiguation artifact → 输出 `ambiguous` |
| 新工具校验 | `selectedAssetId` 不在候选集 → 拒绝 |
| 新工具产出 | 正确 metadata 的 `createdBy:'user'` artifact |
| worker defer | 调用 `record_user_disambiguation` → `requestConfirmation` + defer |
| 硬化 | read/control 工具的 `createdBy:'user'` 被改写为 `'tool'` |

---

## 实施顺序

1. **问题 6**（最小，纯重命名）→ 独立提交
2. **问题 7**（加开关 + 重构返回）→ 独立提交
3. **问题 5**（最复杂，涉及 gate + 新工具 + 硬化）→ 独立提交

每个提交后验证：
```
cd /home/GSMS/agent && node --import tsx --test test/*.test.ts && npx tsc --noEmit
cd /home/GSMS/packages/agent-core && node --import tsx --test test/*.test.ts && npx tsc --noEmit
```

## 不在范围内

- 后端 endpoint（除非选做问题 5 的服务端审计持久化）。
- 阶段四能力扩展（Skill references/examples、多模型推荐、Habitat Quality）。
- `validate_binding_report` 每次重跑 DataMatchingGate：现状已在 gate-blocked 时重跑
  （`gsmsTools.ts:404-406`），符合要求，无需改动。
