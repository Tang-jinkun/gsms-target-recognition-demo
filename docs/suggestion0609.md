我对比了：

```text
基线：6ee17b8 refactor/flexible-workflow-boundary
最新：2a6dc02 feature/agent-streaming
```

近期分支增加约 `4598` 行、修改 `37` 个文件。总体方向约有七成符合原始架构，但目前存在几项会破坏核心契约的问题，**不建议直接把该分支整体作为新的稳定基线**。

**关键问题**

1. **StreamingToolExecutor 绕过 Workflow Boundary**

旧 Runtime 在执行工具前会再次检查：

```text
skillScope
toolFilter
workflowPhaseFilter
```

新的 [StreamingToolExecutor.ts](E:/Github/GSMS/packages/agent-core/src/agent/StreamingToolExecutor.ts) 直接：

```ts
toolRegistry.resolve(call.name)
tool.execute(...)
```

模型即使猜出当前隐藏的执行工具，也可能绕过 Workflow Boundary 执行。这直接破坏：

```text
Workflow Boundary + Tool 确定性执行
```

这是最高优先级问题。

2. **Streaming Executor 丢失了部分 AgentRuntime 契约**

旧 Runtime 会处理：

- `result.activateSkill`
- `result.diagnostics`
- artifact/state 的 Transcript 记录

新 Executor 没有完整处理这些内容。

影响包括：

- Skill 加载后可能没有真正激活 `allowedTools` 范围。
- 工具返回的诊断没有进入最终 diagnostics。
- Artifact 和状态变化的审计记录不完整。

流式执行是合理的，但当前实现借鉴了 Claude Code 的并发形式，没有完整移植其执行契约。

3. **把 `risk: read` 当作“可安全并发”不成立**

当前逻辑：

```ts
const isConcurrencySafe = tool?.risk === 'read'
```

但 GSMS 中很多 read 工具会：

- 创建 Artifact；
- 修改 DomainState；
- 请求后端生成或缓存分析文件。

例如同时执行 `get_invest_model_schema` 与 `list_scene_data_cards`，可能并发修改 `matchingContextId` 和状态。

应该新增显式属性：

```ts
isConcurrencySafe: boolean // 默认 false
```

不能从 `risk` 推导。

4. **Artifact 审计原则被破坏**

Worker 在新运行开始时会删除旧的：

```text
model-job
job-status
validation-report
confirmation-record
result-analysis
invest-report
...
```

这解决了模型误用旧结果的问题，但方法不对。Artifact 应当是追加式审计记录，不应为了控制当前上下文而删除历史证据。

正确方法是：

```text
保留全部历史 Artifact
+ 标记 active run / current evidence context
+ Gate 只读取当前有效证据
```

5. **`userConfirmed: true` 不能证明用户确认**

确定性歧义防护本身很好，但目前 LLM 可以在 `finalize_data_matching` 输入中自行传：

```ts
userConfirmed: true
```

这相当于让模型自己声明“用户已经确认”。必须改为引用真正的用户选择记录或确认 Artifact。

6. **`assess_scene_runnable_models` 过度声明**

该工具目前通过：

```text
有候选数据 + runner available = runnable
```

但没有检查：

- 跨文件关系；
- 官方 InVEST validation；
- 用户确认。

因此它最多能证明：

```text
preliminary_data_sufficient
```

不能证明 `runnable`。工具是有价值的，但名称和输出语义必须收紧。

7. **只读子代理引入过早**

`run_reconnaissance` 的方向可以保留，但现在子代理产生的内部 Artifact 被丢弃，只返回一段 LLM findings。它无法成为父 Agent Gate 可引用的确定性证据。

这不符合：

```text
Artifact 审计 + Gate 证据校验
```

应暂时放到实验开关后面。

---

**符合框架的工作**

以下改动值得保留：

- 流式响应、工具活动日志和前端 Tool Card，明显改善产品体验。
- `sceneDataContextId` 与模型相关 `matchingContextId` 解耦，方向正确。
- Skill 增加 `when-to-use` 和渐进披露，符合 Claude Code 的设计。
- 大工具结果落为 Artifact，符合上下文经济性和审计原则。
- 结构化 ToolFailure 和 `nextAction`，比追加 Skill 警告更可靠。
- DataMatchingGate 的确定性歧义检测理念正确。
- 声明式 `EXECUTION_PIPELINE` 比大量 if-else 更易维护。
- 明确记录技术债务是很好的工程习惯。

所以这批工作不是白做了，而是**扩展速度超过了底层契约的稳定速度**。

---

## 下一步计划

### 阶段一：冻结功能扩展，修复 Runtime 契约

暂缓子代理、多模型扩展和更多 Workflow 功能。

优先修复 `StreamingToolExecutor`：

1. 执行前再次校验工具可见性和 Skill scope。
2. 完整处理 `activateSkill`、`diagnostics`、`hiddenMessages`、Artifact 和 Transcript。
3. 增加显式 `isConcurrencySafe`，默认 `false`。
4. 写以下 Runtime 回归测试：
   - 隐藏工具即使被模型猜中也不能执行。
   - Skill 激活后权限范围生效。
   - Tool diagnostics 能进入最终结果。
   - 两个会修改状态的 read 工具不会并发执行。
   - 权限延迟后其他工具不会继续产生副作用。

这部分属于通用 Agent Runtime，值得放在 `agent-core`。

### 阶段二：建立追加式 Evidence Ledger

停止删除历史 Artifact。

新增明确作用域：

```ts
sceneDataContextId
matchingContextId
validationSnapshotId
jobId
runId
```

Gate 和 Resume Context 只读取当前有效作用域，历史 Artifact 保留供审计和前端查看。

同时将：

```text
phase
当前用户请求
当前有效证据
历史执行记录
```

拆成不同概念，避免 `phase` 承担全部职责。

### 阶段三：收紧领域语义

- 将 `assess_scene_runnable_models` 改成 `assess_scene_model_readiness`。
- 输出明确区分：

```text
runner_available
data_sufficient
ready_for_validation
validated
confirmed
runnable_now
```

- `userConfirmed` 必须引用真实的用户选择 Artifact。
- `validate_binding_report` 每次重新运行 DataMatchingGate，不依赖旧 metadata。

### 阶段四：再恢复智能能力扩展

底层稳定后：

- 继续完善 Skill 的 references、examples 和失败恢复指导。
- 子代理只返回结构化调查结果，父 Agent 必须用确定性 Tool 验证后才能形成证据。
- 再考虑多模型智能推荐和 Habitat Quality。

---

**建议拆分分支**

当前 `feature/agent-streaming` 混合了 UI、Runtime、Skill、Gate、子代理和业务工具。建议拆成三个可独立审核的 PR：

```text
1. streaming-transport-and-ui
2. runtime-execution-contract
3. matching-intelligence-and-gates
```

其中第一部分基本可以保留；第二部分必须先修复上述阻断问题；第三部分在 Evidence Ledger 稳定后再合并。