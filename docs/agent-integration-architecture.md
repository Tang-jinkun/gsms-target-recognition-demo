# GSMS Agent Integration Architecture

## Ownership

GSMS is the product and scientific runtime source of truth.

- `backend/` owns Data Hub records, file inspection, model schemas, validation,
  InVEST execution, jobs, logs, and outputs.
- `packages/agent-core/` owns the provider-neutral agent loop, tools,
  permissions, artifacts, domain state, and transcript.
- `packages/skills-core/` owns Skill loading, progressive disclosure,
  authorization, and execution scope.
- `agent/` owns InVEST-specific orchestration and converts GSMS API responses
  into artifacts the agent can reason over.

The agent must not execute InVEST or inspect GIS files directly. It calls
structured GSMS APIs for deterministic facts and scientific operations.

## Current Integration

Agent-facing GSMS APIs:

```text
GET  /api/models
GET  /api/models/{model_id}/schema
GET  /api/scenes/{scene_id}/data-cards
POST /api/matching/check-relation
POST /api/models/{model_id}/validate-bindings
GET  /api/validation-snapshots/{snapshot_id}
POST /api/validation-snapshots/{snapshot_id}/confirm
POST /api/validation-snapshots/{snapshot_id}/jobs
GET  /api/scenes/{scene_id}/jobs/{job_id}
GET  /api/scenes/{scene_id}/jobs/{job_id}/outputs
GET  /api/scenes/{scene_id}/jobs/{job_id}/logs
POST /api/agent/chat/completions
```

The first supported relation is Carbon LULC code coverage:

```json
{
  "kind": "code-coverage",
  "left_asset_id": "lulc-data-file-id",
  "right_asset_id": "carbon-pools-data-file-id",
  "field": "lucode"
}
```

## Migration Rules

The Agent generates matching slots from the GSMS model schema response. GSMS
model schemas own required fields, semantic terms, and matching relations.
Relation checks are executed by GSMS and normalized into Agent artifacts.

Binding Reports are submitted to GSMS validation before the Agent may request
user confirmation. GSMS converts selected asset IDs to model inputs, verifies
that assets belong to the scene, blocks asset IDs supplied through the
parameters channel, and calls the registered model input checker. Validation
returns and persists a stable `snapshot_id` derived from the exact model,
scene, and inputs.

Confirmation decisions are persisted against that snapshot. The Agent can
create a model job only from the exact confirmed snapshot, and a snapshot may
create at most one job. Consuming the snapshot and creating the Job database
record are committed in one transaction.

Selected input assets are SHA-256 fingerprinted during validation. Their
fingerprints participate in snapshot identity and are checked again before
confirmation and execution. Changed or missing assets invalidate the snapshot.

When a confirmed snapshot creates a Job, selected assets are copied into the
Job's immutable `inputs/` directory and verified against the snapshot hashes.
The runner reads only these frozen copies and verifies `input-manifest.json`
immediately before invoking the model.

After execution, the Agent refreshes the exact current Job, inspects its
structured output inventory, and creates a result interpretation context from
the outputs and execution log. Failed Jobs produce diagnostics and cannot
advance to output interpretation.

The final `write_invest_report` tool renders a deterministic Markdown report
from persisted artifacts and a bounded Agent-authored interpretation. Reports
are written to `runs/<job-id>/report.md` inside the Agent workspace.

The interactive CLI reuses the GSMS default LLM Provider metadata. When
`GSMS_AGENT_PROXY_TOKEN` is configured, OpenAI-compatible requests pass through
the authenticated server-side GSMS model proxy, so the saved Provider API key
is never returned to the CLI. The CLI preserves artifacts, domain state, and
recent conversation summaries across user turns.

GSMS now also owns a persisted Agent session protocol. Sessions bind a Scene to
messages, events, domain state, artifacts, model metadata, and structured
confirmations. The API separates browser-facing message/confirmation actions
from Worker-facing checkpoints, allowing the CLI and Web chat to converge on
the same recoverable execution state.

The TypeScript Agent Worker polls queued sessions, atomically claims one through
the GSMS checkpoint API, restores persisted state and artifacts, and executes
the provider-neutral Agent runtime. Protected tools pause the run and create a
structured confirmation. Approved confirmations are matched against the exact
tool input and consumed once before execution.

The scene-scoped GSMS Web workbench now restores or creates a persisted Agent
session, submits natural-language messages to its queue, polls recoverable
messages and status, and renders structured approval/rejection controls for
protected actions. The existing chat layout is retained while the former local
simulated response is bypassed.

## Safety Boundary

- Skills guide agent behavior but cannot run arbitrary scripts.
- Matching tools return facts and evidence, not final binding decisions.
- Binding Reports record agent decisions and uncertainty.
- GSMS validation and user confirmation gate model execution.
- Agent-created jobs must reference a confirmed validation snapshot.

## Remaining Work

- Add database-backed API integration tests for concurrent confirmation and
  job creation.
- Replace Web polling with SSE while retaining the persisted event cursor as a
  reconnect fallback.
- Add model-specific deterministic output statistics for Carbon and Habitat
  Quality so reports can include validated quantitative summaries.
