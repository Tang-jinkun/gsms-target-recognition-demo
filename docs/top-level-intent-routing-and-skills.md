# GSMS 顶层意图路由与 Skill 协同升级计划

## Summary

GSMS Agent 的入口从“所有用户请求默认进入 InVEST 工作流”升级为“先做顶层意图识别，再按意图装配 runtime”。顶层 `TurnIntentRouter` 负责判断本轮是普通问答、InVEST 工作流、继续既有工作流，还是需要澄清。Skill 不承担意图识别本身，而是作为专业工作流能力包，在 Router 判定进入领域任务后按需加载。

## Key Decisions

- 不把“意图识别”做成 Skill。
- 保留独立的 `TurnIntentRouter` 作为 `AgentRuntime` 之前的 preflight 层。
- Skill 的角色是“专家说明书”：定义某类任务怎么做、何时适用、允许哪些工具。
- Router 可以读取 Skill metadata 中的触发描述，辅助选择 Skill，但 Skill 不负责决定自己是否出场。
- Router 输出结构化 `TurnPlan`，供 worker、CLI、前端状态展示共同使用。

## Target Architecture

固定入口顺序：

```text
user message
  -> TurnIntentRouter
  -> TurnPlan
  -> Runtime Assembly
  -> AgentRuntime.run()
```

`TurnPlan` 至少包含：

```ts
type TurnPlan = {
  intent: 'general-answer' | 'invest-workflow' | 'workflow-continue' | 'ambiguous'
  confidence: number
  reason: string
  workflow?: {
    action?: 'assess-runnable-models' | 'match-inputs' | 'validate' | 'confirm' | 'execute' | 'inspect-results' | 'write-report'
    modelId?: string
    continuationTarget?: string
  }
  toolPolicy: {
    exposeGsmsTools: boolean
    exposeSkills: string[]
    useWorkflowPhaseFilter: boolean
  }
  promptContext: {
    includeSceneId: boolean
    includeDomainState: boolean
    includeWorkflowResumeContext: boolean
    clarificationQuestion?: string
  }
}
```

## Runtime Strategies

- `general-answer`：不注入 scene、phase、domain state、workflow resume context；不暴露 GSMS/InVEST 工具；不修改 artifacts/domain state。
- `ambiguous`：只追问澄清；不启动工作流；不修改 workflow state。
- `invest-workflow`：注入 scene、domain state、workflow directive；暴露 GSMS tools、相关 Skills、phase filter。
- `workflow-continue`：读取当前 phase 和 artifacts；继续既有 gate，不重做已完成阶段。

## Skill Metadata

Skill metadata 用于轻量路由辅助，不加载完整 Skill 正文。建议 frontmatter 使用：

```yaml
name: data-matching
description: 匹配 InVEST 模型输入与当前场景数据
when_to_use: 用户要求匹配模型输入、判断当前场景数据是否满足模型运行、绑定 LULC 或 CSV 参数
intent_tags:
  - match-inputs
  - assess-data-sufficiency
trigger_examples:
  - 帮我匹配 Carbon 模型输入
  - 当前场景的数据能不能跑 Carbon
allowed_tools:
  - list_scene_data_cards
  - get_invest_model_schema
  - retrieve_input_candidates
  - finalize_data_matching
```

加载策略：

- system prompt 只放 Skill 摘要列表。
- Router 只读取 `description`、`when_to_use`、`intent_tags`、`trigger_examples` 等摘要字段。
- 完整 `SKILL.md` 只在 `invest-workflow` 或 `workflow-continue` 下按需加载。
- 普通问答 runtime 使用空 Skill registry。

## Claude Code Mapping

- Router 类似 `UserPromptSubmit` / prompt hook：在进入主 runtime 前决定本轮上下文。
- Skill 类似按需加载的专业能力包：只在相关任务中展开正文。
- Tool policy 类似 turn-scoped allowed tools：按本轮 intent 决定暴露哪些工具和过滤规则。

## Test And Acceptance

- Router：算术、问候、翻译、普通概念解释走 `general-answer`。
- Router：当前场景模型可运行性、模型输入匹配走 `invest-workflow`。
- Router：存在可继续 phase/artifact 时，“验证刚才的方案”走 `workflow-continue`；无状态的“继续”走 `ambiguous`。
- Worker/CLI：普通问题不重置 phase，不暴露 GSMS tools、Skill tool，不修改 workflow state。
- Worker/CLI：InVEST 请求仍进入匹配、验证、确认、执行链路。
- 前端：普通问题只显示普通回答；内部控制工具 `finish` / `update_goal` 不渲染为活动卡片。

## Assumptions

- v1 默认继续使用确定性规则，classifier 是可选增强，不强依赖外部模型。
- 分类错误的安全默认是 `ambiguous`，不是启动 InVEST。
- 不改造现有 `DataMatchingGate`、`ValidationSnapshot`、`ExecutionGate`；Router 只决定是否进入这些 gate。
- 当前已有 `data-matching` Skill 保留，通过 metadata 增强路由协同。

## Optional Classifier Configuration

Classifier 是一个 OpenAI-compatible `ModelAdapter`，默认复用主 Agent LLM，只在确定性规则和 Skill metadata 都无法分类时调用。调用时不暴露工具，并要求模型只返回 JSON。

默认不需要额外配置；CLI 和 worker 都会复用主 LLM。若要改用更便宜/更快的小模型，CLI 支持：

```bash
invest-agent \
  --intent-classifier-model qwen-turbo \
  --intent-classifier-base-url http://127.0.0.1:8000/api/agent \
  --intent-classifier-api-key "$GSMS_AGENT_PROXY_TOKEN"
```

CLI 和 worker 都支持环境变量覆盖：

```bash
INVEST_AGENT_INTENT_CLASSIFIER_MODEL=qwen-turbo
INVEST_AGENT_INTENT_CLASSIFIER_BASE_URL=http://127.0.0.1:8000/api/agent
INVEST_AGENT_INTENT_CLASSIFIER_API_KEY=...
```

如果只配置 `INVEST_AGENT_INTENT_CLASSIFIER_MODEL`：

- CLI 默认复用主 Agent 模型的 base URL 和 API key。
- worker 默认复用 GSMS provider proxy：`${GSMS_URL}/api/agent` 和 `GSMS_AGENT_PROXY_TOKEN`。

如果要关闭 LLM fallback classifier：

```bash
INVEST_AGENT_DISABLE_INTENT_CLASSIFIER=1
```

关闭后行为回到纯规则路由；规则无法判断则返回 `ambiguous`。
