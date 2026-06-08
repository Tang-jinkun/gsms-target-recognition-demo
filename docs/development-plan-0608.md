这份评价总体准确。它补上了一个非常重要的工程判断：

> 我们需要证据门禁，但现在不应该立刻设计一套包罗万象的通用 Claim Validator。

当前最适合的路线是：**从 Data Matching 建立第一个完整可信闭环，再沿真实业务链路逐步增加 Gate。**

## 核心架构定稿

建议将架构正式定义为：

```text
LLM 决定业务判断与探索路径
Skill 提供领域方法、规程与示例
Tool / Primitive 获取事实并执行操作
Artifact 保存可审计证据
Gate 校验关键结论和阶段转换
Workflow Boundary 限制不可绕过的阶段前置条件
```

其中：

- 探索路径可以灵活。
- 阶段转换必须严格。
- Gate 检查证据，不检查固定工具调用顺序。
- 业务流程知识优先写入 Skill。
- `agent-core` 保持领域无关。
- 第一版实现具体 Gate，不建设通用声明推理系统。

---

# 阶段一：梳理架构边界

目标：停止继续向 `flexible-workflow-boundary` 中堆叠多种职责。

## 工作内容

审计现有代码并为每段逻辑分类：

| 类型 | 应放位置 |
|---|---|
| Agent 循环、工具调用、通用权限 | `agent-core` |
| Skill 加载与执行 | `skills-core` |
| InVEST 专业流程知识 | InVEST Skills |
| GSMS API 调用、确定性检查 | GSMS Tools |
| Artifact 生成和持久化 | Artifact 层 |
| InVEST 阶段转换条件 | `invest-agent` Gate |
| 工具可见性和用户请求边界 | Workflow Boundary |

重点清理：

- 从 `agent-core` 移除 GSMS/InVEST 领域提示和证据判断。
- 拆分当前 Workflow 中混合的意图判断、工具排序和证据检查。
- 将 Workflow 定义收敛为“不可绕过的前置条件”。
- 给 Artifact 增加统一上下文元数据。

```ts
interface ArtifactContext {
  projectId: string
  sceneId: string
  modelId?: string
  matchingContextId?: string
  sourceArtifactIds?: string[]
  createdAt: string
}
```

## 验收标准

- `agent-core` 不出现 Carbon、Habitat、GSMS、场景数据等领域词汇。
- Workflow 不再通过固定工具顺序控制 Agent。
- 能明确回答每项约束属于 Skill、Gate 还是权限系统。

---

# 阶段二：完成 Data Matching 闭环

这是当前优先级最高的阶段。暂时只把 Carbon 做扎实。

## 目标流程

LLM 可以自由决定调查顺序，但最终生成 Binding Report 前必须满足 `DataMatchingGate`。

```text
LLM + Data Matching Skill
        ↓
Matching Primitives
        ↓
Matching Artifacts
        ↓
DataMatchingGate
        ↓
Binding Report 可进入验证 / 需要用户处理
```

## Matching Artifacts

明确并稳定以下 Artifact：

```text
model-input-schema
data-card
candidate-set
relation-check
binding-report
```

每个 Artifact 必须绑定当前 `matchingContextId`：

```text
sceneId
+ modelId
+ modelSchemaVersion
+ 当前数据资产指纹
= matchingContextId
```

## DataMatchingGate

第一版只检查具体、必要的条件：

1. Binding Report 存在。
2. `matchingContextId` 当前有效。
3. 所有必填槽位都有明确状态。
4. 已选资产真实存在于当前场景。
5. 已选资产来自对应槽位的候选集合。
6. 不存在必需输入缺失。
7. 不存在未解决的候选歧义。
8. 不存在阻断性的关系检查失败。
9. 未执行必要关系检查时，只能标记 `needs_review`，不能标记 `ready`。
10. 推荐的下一步动作与当前状态一致。

## 关键原则

不要要求 LLM 必须调用：

```text
A → B → C → D
```

而应要求它最终提交的 Binding Report 能通过 Gate。

例如 LLM 可以先查看数据，也可以先看 Schema；但没有当前 Schema 和候选证据，就不能声称 Carbon 数据已经完整匹配。

## 测试重点

- 完整 Carbon 数据生成 `ready_for_validation`。
- 缺少碳池表时生成 `missing_input`。
- baseline 与 alternate 歧义时生成 `needs_review`。
- 旧场景 Candidate Set 不能参与当前匹配。
- 数据文件变化后，旧 Binding Report 自动失效。
- 只有模型列表时，不允许声称“当前场景可运行 Carbon”。

---

# 阶段三：数据充足性与模型可运行性评估

完成单模型 Matching 后，再处理“当前场景能运行哪些模型”这种跨模型问题。

## 新增两个具体 Gate

### `DataSufficiencyGate`

判断：

```text
当前场景是否拥有模型需要的数据
```

它不判断运行器状态，也不执行官方验证。

### `RunnableGate`

判断：

```text
数据是否充足
+ 阻断关系检查是否通过
+ 模型 Runner 是否可用
```

必须严格区分以下声明：

| 声明 | 含义 |
|---|---|
| `scientifically_relevant` | 模型适合回答用户问题 |
| `data_sufficient` | 当前数据看起来齐全 |
| `ready_for_validation` | 可进入官方验证 |
| `runnable` | Runner 可用且验证、确认条件满足 |

这样 Agent 就不会再把“Carbon 已注册”直接总结为“Carbon 当前可运行”。

## Skill 调整

`data-matching` Skill 应说明如何评估多个模型，但不规定固定工具顺序。

模型状态、Runner 可用性和 Schema 属于 Tool 事实；哪个模型值得调查、如何解释差异属于 LLM 判断。

---

# 阶段四：验证、快照与确认闭环

Data Matching 稳定后，再完善执行前防护。

## 新增 `ValidationGate`

检查：

- Binding Report 已通过 `DataMatchingGate`。
- 官方 InVEST `validate(args)` 已执行。
- 验证结果绑定不可变输入快照。
- 不存在阻断性错误。
- 数据或参数变化后旧验证自动失效。

## 新增 `ExecutionGate`

检查：

- Validation Snapshot 通过。
- 用户确认绑定到同一个 Snapshot。
- 当前请求没有“不要执行”边界。
- Runner 当前可用。
- 输入、参数、模型版本均未变化。

阶段标识建议明确拆分：

```text
matchingContextId
bindingReportId
validationSnapshotId
userConfirmationId
jobId
```

## 验收重点

- 用户确认旧快照后修改参数，禁止执行。
- 用户说“验证但不要执行”，执行工具不可用。
- Agent 可以自由解释和追问，但不能绕过验证与确认。

---

# 阶段五：结果分析与报告可信闭环

当前已有结果分析能力，但需要形成独立 Gate。

## 新增 `ReportGate`

检查：

- 作业真实成功。
- 输出已经清点。
- 输出指纹有效。
- `result-analysis` 来自当前输出。
- 报告引用的 Metric ID 存在。
- 报告数字全部来自确定性分析。
- 未分类输出不能被赋予未经证实的生态含义。

LLM 负责解释数字的意义，Tool 负责提供数字，Gate 负责阻止编造数字。

## 工程补强

- 大栅格采用窗口或分块统计，避免一次性读入内存。
- `result-analysis`、中间 Artifact 和报告进入 Data Hub。
- 旧的简单解释报告不能被当作确定性分析报告复用。

---

# 阶段六：逐步抽象通用能力

只有至少完成以下具体 Gate 后，才考虑抽象：

```text
DataMatchingGate
RunnableGate
ValidationGate
ExecutionGate
ReportGate
```

届时再观察共同结构是否稳定，例如：

```ts
interface GateResult {
  passed: boolean
  status: string
  blockingReasons: GateReason[]
  evidenceArtifactIds: string[]
  nextActions: NextAction[]
}
```

如果多个 Gate 确实出现稳定重复，再抽象通用 `ClaimValidator`。

不要现在就设计：

- 通用声明逻辑语言。
- 任意 Claim 与证据类型映射系统。
- 复杂规则 DSL。
- 全流程统一状态机。

这些很容易形成第二套 Workflow，反过来压制 Agent 自主性。

---

# Skill 的同步建设路线

Skill 不应只是较长的 Prompt。建议逐步完善为能力包：

```text
data-matching/
  SKILL.md
  references/
    carbon.md
    habitat-quality.md
  examples/
    carbon-complete.md
    carbon-ambiguous.md
    carbon-missing-input.md
  templates/
    matching-summary.md
```

Skill 应负责：

- 专业调查方法。
- 候选判断维度。
- 关系检查建议。
- 风险解释方式。
- 失败恢复策略。
- 推荐下一步的选择方法。

Skill 不应负责：

- 伪造 Artifact。
- 宣布 Gate 已通过。
- 扩大权限。
- 绕过用户确认。
- 把推荐顺序变成不可变顺序。

---

# 推荐开发顺序

| 优先级 | 阶段 | 交付物 |
|---|---|---|
| P0 | 架构边界审计 | 职责清单、清理方案、领域泄漏列表 |
| P0 | Carbon Data Matching 闭环 | `DataMatchingGate` 与上下文隔离 |
| P0 | 匹配回归测试 | 完整、缺失、歧义、旧证据四类场景 |
| P1 | 多模型充足性判断 | `DataSufficiencyGate`、`RunnableGate` |
| P1 | 验证与执行闭环 | `ValidationGate`、`ExecutionGate` |
| P2 | 结果与报告可信性 | `ReportGate`、Data Hub 可见性 |
| P3 | 通用抽象 | 根据多个具体 Gate 抽象公共接口 |

## 当前最近的一步

当前不要继续优化“灵活 Workflow”这个大概念。

下一轮开发应集中完成：

> **保持 LLM 自由探索的前提下，实现 Carbon `DataMatchingGate`，并确保只有当前上下文中证据完整的 Binding Report 才能进入 Validation。**

这是最小、最有价值，也最能验证整套架构是否成立的一步。