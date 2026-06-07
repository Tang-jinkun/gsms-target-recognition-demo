# Clean-room Agent

A provider-neutral autonomous agent runtime built around `@gsms/skills-core`.
The model chooses relevant skills and tools; the runtime enforces workspace,
permission, turn-budget, and completion rules.

## Run

```powershell
npm install
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "your-tool-calling-model"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1" # optional
npm start -- "Review this project and write a findings report"
```

Read and search tools execute automatically. File writes and shell commands
require interactive approval. Project skills require approval the first time
their current content is invoked.

## Architecture

- `AgentRuntime`: bounded model/tool loop and goal lifecycle.
- `ModelAdapter`: provider-neutral model interface.
- `ToolRegistry`: model-visible control and action tools.
- `PermissionManager`: read/control auto-allow, write/execute approval.
- `SkillAgentTool`: injects selected skill instructions and narrows action tools.
- `Transcript`: records model messages, calls, results, permissions, and outcome.

Inline skills work directly in the main loop. Hosts that enable isolated skills
must provide `runIsolated` to `createSkillAgentTool`; without it, isolated skill
execution fails explicitly.

## Domain Boundary

`agent-core` is deliberately domain-neutral. It may implement reusable runtime
mechanisms such as tool calling, skill activation, permission checks, bounded
loops, generic workflow-state persistence, artifacts, diagnostics, and audit
events.

It must not contain product or domain knowledge, including:

- GSMS, InVEST, Carbon, Habitat Quality, scene, or model-specific behavior.
- User-intent keyword routing or rules that prescribe a domain tool sequence.
- Domain phase names, schemas, validation rules, report contents, or data types.
- Special cases added only to make one domain workflow succeed.

Domain workflows belong in Skills and host-provided tools. Hosts may use the
generic state, artifact, permission, and tool-filtering interfaces to enforce
safety and evidence integrity without teaching `agent-core` the domain.

Before changing `agent-core`, verify that the behavior is reusable outside the
current application, keep the change minimal, and cover it with domain-neutral
tests.
