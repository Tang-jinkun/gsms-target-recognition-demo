# GSMS InVEST Agent Workbench

GSMS is a local WebGIS workbench and domain Agent for running and explaining
InVEST ecosystem-service models. The core idea: **let the LLM understand user
intent and plan execution steps, but all scientific computation and data
statistics are performed by deterministic backend tools** — eliminating LLM
"hallucinated" numbers from scientific outputs.

The current development focus is an Agent that can understand a user's
natural-language task, select a suitable InVEST model, match scene data,
validate inputs, execute a confirmed run, and explain the outputs using
deterministic analysis rather than invented LLM numbers.

The first supported real workflow is InVEST Carbon on the Willamette sample
data. Habitat Quality and additional InVEST models are planned after the Carbon
chain is stable.

## Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│  Frontend (Next.js 13 + MapLibre GL)                      │
│  Three-panel layout: Agent Chat | Map | Model/Files Panel  │
│  Pages: dashboard / scenes / data-hub / skills /           │
│         settings / workbench/[sceneId]                     │
│  State: Repository pattern (6 repos in src/lib/repos/)     │
└─────────────────────────┬─────────────────────────────────┘
                          │ HTTP API
┌─────────────────────────▼─────────────────────────────────┐
│  Backend (FastAPI + PostGIS + SQLAlchemy)                  │
│  8 Routers: scenes / data / scene_files / jobs /           │
│    matching / agent / skills / settings                     │
│  13 DB tables + 4 Alembic migrations                       │
│  Core modules:                                             │
│    · result_analysis.py — deterministic raster statistics  │
│    · invest_models/registry.py — model registry            │
│    · run_job.py — subprocess InVEST execution              │
│    · llm_proxy.py — server-side LLM proxy (Fernet)         │
│    · crypto.py — API key encryption                        │
│    · storage.py — filesystem path management               │
└─────────────────────────┬─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│  Agent (TypeScript, two modes)                             │
│  · CLI mode — interactive REPL                             │
│  · Worker mode — polls backend queue, atomic session claim │
│  · 12+ tool functions (gsmsTools / matchingTools /         │
│    reportTools)                                            │
│  · 2 builtin Skills (data-matching / interpret-results)    │
│  · workflowBoundary.ts — workflow phase boundary control   │
│  · report/buildInvestReport.ts — deterministic report gen  │
└─────────────────────────┬─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│  packages/                                                 │
│  · agent-core — model-agnostic Agent runtime               │
│    AgentRuntime / ToolRegistry / ArtifactStore /           │
│    DomainStateStore / PermissionManager /                  │
│    OpenAICompatibleAdapter / Transcript                    │
│  · skills-core — Skills infrastructure                     │
│    SkillLoader / SkillRegistry / SkillExecutor /           │
│    SkillWatcher (hot-reload)                               │
└───────────────────────────────────────────────────────────┘
```

## Directory Structure

- `frontend/`: Next.js 13 WebGIS workbench, scene UI, Data Hub, MapLibre map,
  and Agent chat. Tailwind CSS + PostCSS + lucide-react icons.
- `backend/`: FastAPI service, scene/data/job APIs, InVEST execution, result
  analysis, persistent Data Hub metadata. Python 3.10 + PostGIS + SQLAlchemy +
  Alembic.
- `agent/`: InVEST Agent worker and CLI. It talks to the backend and an
  OpenAI-compatible model API. Two modes: CLI (interactive REPL) and Worker
  (polls backend for queued sessions).
- `packages/agent-core`: model-agnostic Agent runtime inspired by Claude Code.
  Provides AgentRuntime, ToolRegistry, ArtifactStore, DomainStateStore,
  PermissionManager, and OpenAI-compatible model adapter.
- `packages/skills-core`: clean-room Skills infrastructure. SkillLoader,
  SkillRegistry, SkillExecutor, SkillWatcher with hot-reload support.
- `sample_data/`: fixed sample inputs for Carbon testing.
- `docs/`: implementation notes, acceptance plans, and development guidelines.
- `open_design/`: HTML prototype files and design handoff.
- `scripts/`: Docker and local startup helpers (cross-platform).

The Agent should reason and plan, but scientific and filesystem operations are
performed by deterministic backend tools. The LLM must not directly run InVEST
or fabricate output statistics.

## Design Philosophy

### 1. Agent Decides, Skills Guide, Tools Execute, Gates Protect

This is the most important architectural decision in the project:

- **Agent / LLM**: chooses business judgments and investigation paths.
- **Skills** (`SKILL.md` files): encode domain methods, procedures, examples,
  and recovery guidance. They recommend how to investigate without defining a
  mandatory tool-call sequence.
- **Tools / Primitives**: obtain deterministic facts or perform local actions.
- **Artifacts**: preserve auditable evidence produced by tools and stages.
- **Gates**: validate critical conclusions and stage transitions using current
  evidence. They do not replace the Agent's business judgment.
- **Workflow Boundary**: enforces only non-bypassable prerequisites and
  current-request restrictions.
- **agent-core Runtime**: completely model-agnostic. Contains no InVEST-specific
  logic. Swapping the LLM model or even the domain requires no changes to
  Runtime or Tools.

The governing rule is **flexible exploration, strict transitions**. The Agent
may choose how to investigate, but cannot claim readiness or cross a protected
stage without sufficient current-context evidence.

### 2. Validation Snapshot Immutability

When the Agent's data matching produces a Binding Report, the backend validates
it and generates a **SHA-256 snapshot ID** (a hash of the exact model, scene,
inputs, and asset fingerprints). A snapshot can create at most one job, and
assets are fingerprinted and frozen into an immutable `inputs/` directory. This
guarantees **reproducibility**.

### 3. Agent Session Protocol

Sessions are persisted in PostgreSQL with messages, events, domain state,
artifacts, and structured confirmation records. The Worker claims sessions
atomically via checkpoint and supports resumption from persisted state. Browser
and CLI converge on the same recoverable execution state.

### 4. Server-Side LLM Proxy

The Agent Worker **never sees the raw API key**. The backend stores
Fernet-encrypted provider keys; the Worker authenticates with a proxy token
only. Model selection happens in the frontend Agent chat dropdown.

### 5. Workflow Boundary and Evidence Gates

`workflowBoundary.ts` limits non-bypassable transitions and prevents actions
that conflict with the current request:

```
matching → validation → confirmation → execution → interpretation
```

The boundary must not prescribe one fixed investigation sequence. Concrete
evidence Gates validate whether matching, validation, execution, and reporting
transitions are supported by current Artifacts. See
`docs/evidence-gated-agent-development-plan.md`.

### 6. Data Hub as Global File Store

Files live on disk under `project_files_dir()` with metadata and vector
geometry in PostGIS. Scenes import files by reference (SceneImport join table),
not by copy. Job outputs are automatically registered into Data Hub under
task-named folders. Agent-produced intermediate artifacts (`result-analysis.json`,
etc.) are also visible to users.

## Current Development Focus

The current architecture work is being developed on:

```text
refactor/flexible-workflow-boundary
```

The result interpretation chain is operational. Current work is separating
Skill guidance, deterministic Tools, auditable Artifacts, evidence Gates, and
Workflow Boundary responsibilities. The immediate milestone is a Carbon
`DataMatchingGate` that validates a completed Binding Report without forcing
the Agent through a fixed tool-call sequence.

The operational result interpretation chain is:

```text
inspect_invest_job_outputs
-> analyze_invest_results
-> interpret_invest_results
-> write_invest_report
```

Important behavior:

- `analyze_invest_results` calls the backend to read real GeoTIFF output pixels.
- The backend writes and caches `result-analysis.json`.
- The report's numerical tables come from `result-analysis`, not from the LLM.
- If the model writes unsupported numbers in prose, the report tool sanitizes
  that prose and still writes the report.
- If the model passes a filename such as `c_storage_bas_mvp.tif` as a highlight,
  the report tool maps it to the corresponding raster metric when possible.
- Agent intermediate evidence files are published into Data Hub under
  `Agent Outputs` and imported into the current scene:
  - `job-output-inventory.json`
  - `result-analysis.json`
  - `result-interpretation-context.json`
  - `report.md`

## Data Flow: A Complete Carbon Job

```
User natural-language request
  │
  ▼
Agent infers workflow phase → loads corresponding Skill
  │
  ▼
[matching] retrieve_input_candidates → finalize_data_matching
  │
  ▼
[validation] validate_binding_report → backend generates snapshot (SHA-256)
  │
  ▼
[confirmation] confirm_validation_snapshot → user confirms
  │
  ▼
[execution] execute_validated_snapshot → backend subprocess runs InVEST
  │
  ▼
[interpretation]
  get_invest_job_status
  → inspect_invest_job_outputs        (inventory output files)
  → analyze_invest_results            (backend reads real GeoTIFF pixels,
                                       generates result-analysis.json)
  → interpret_invest_results          (interpretation based on real data)
  → write_invest_report               (all numbers from result-analysis;
                                       unsupported LLM prose is sanitized)
  │
  ▼
finish → all artifacts published to Data Hub
```

## Database Schema

13 tables (see `backend/app/models.py`):

| Table | Purpose |
|-------|---------|
| `scenes` | Project scenes with name, description, study area |
| `data_folders` | Data Hub folder organization |
| `data_files` | Global file records with CRS, bounds, extra metadata |
| `scene_imports` | Many-to-many scene-to-file references |
| `features` | PostGIS vector geometry for spatial queries |
| `jobs` | Model execution jobs linked to scenes |
| `job_outputs` | Per-job output file records |
| `validation_snapshots` | Immutable validation state with asset fingerprints |
| `skills` | Registered skill metadata |
| `users` | Single-user profile |
| `llm_providers` | Encrypted LLM provider configurations |
| `agent_sessions` | Persisted agent conversation state |
| `agent_messages` | Session messages |
| `agent_events` | Auditable action events |
| `agent_confirmations` | Structured approval/rejection records |

Four Alembic migrations at `backend/alembic/versions/`.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 13.5, React 18.2, MapLibre GL 2.4, Tailwind 3.4, TypeScript |
| Backend | Python 3.10, FastAPI, SQLAlchemy, PostGIS, Alembic, rasterio 1.4.3, natcap.invest 3.19.0 |
| Agent | TypeScript, Node.js, OpenAI-compatible API |
| Database | PostgreSQL 16 + PostGIS 3.4 |
| Deployment | Docker Compose, micromamba |
| Encryption | Fernet (symmetric) |

## Docker Deployment

On the Linux server:

```bash
cd /path/to/GSMS
git fetch origin
git switch feat/deterministic-result-analysis
git pull
docker compose up -d --build backend agent-worker frontend
docker compose ps
```

If only Agent code changed, rebuilding the worker is usually enough:

```bash
docker compose up -d --build agent-worker
```

The default services are:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://<server>:3000`
- Agent worker workspace: Docker volume `agent-data`
- Backend persistent data: Docker volume `backend-data`

The helper script `scripts/start_docker_gsms.sh` initializes required secrets in
`.env`, including the Fernet key and Agent proxy token.

## Model Configuration

The web Agent uses the GSMS backend's model-provider proxy. In normal server
deployment, the worker does not need a raw provider API key. It uses:

```text
GSMS_URL=http://backend:8000
GSMS_AGENT_PROXY_TOKEN=<from .env>
```

The selected model is chosen in the frontend Agent chat dropdown. Earlier
decryption errors such as `Could not decrypt the default Provider API key`
usually mean the backend `.env` or database provider secret was created with a
different Fernet key.

## Manual End-to-End Test

Use a scene that already has the Carbon sample data and a succeeded Carbon job.
One known test job used during development was:

```text
scene: a4ea0c7d85534e68ac2861561ef84360
job:   a60e72d4a3bb4e58b524e681065f9256
```

In the Agent chat, ask:

```text
重新检查 Carbon 作业 a60e72d4a3bb4e58b524e681065f9256 的真实输出，
重新执行确定性结果分析并生成新报告。不要复用旧报告。
所有数字必须来自 result-analysis。
```

Expected activity sequence:

```text
get_invest_job_status
inspect_invest_job_outputs
analyze_invest_results
interpret_invest_results
write_invest_report
finish
```

Expected artifacts:

```text
job-status
job-output-inventory
result-analysis
result-interpretation-context
invest-report
```

Then open `Data Hub -> Agent Outputs`. The generated evidence files and
`report.md` should be visible. Use the detail panel's `下载 / 打开文件` button to
open each file.

## Backend Result Analysis API

Analyze a succeeded job:

```bash
export SCENE_ID=a4ea0c7d85534e68ac2861561ef84360
export JOB_ID=a60e72d4a3bb4e58b524e681065f9256
export GSMS_URL=http://127.0.0.1:8000

curl -fsS -X POST \
  "$GSMS_URL/api/scenes/$SCENE_ID/jobs/$JOB_ID/analyze-results" \
  | tee /tmp/result-analysis.json | jq
```

Inspect key statistics:

```bash
jq '.rasters[] | {
  filename,
  role,
  quantity,
  unit,
  validPixels: .statistics.validPixels,
  total: .statistics.total,
  mean: .statistics.mean,
  median: .statistics.median
}' /tmp/result-analysis.json
```

Fetch cached analysis:

```bash
curl -fsS \
  "$GSMS_URL/api/scenes/$SCENE_ID/jobs/$JOB_ID/result-analysis" \
  | jq
```

The cached result should be identical while output fingerprints are unchanged.

## Agent Tools Reference

The Agent exposes 12+ tools organized into three groups:

**gsmsTools** — InVEST model and job management:
- `list_invest_models` — list available InVEST models
- `get_invest_model_schema` — get model input schema
- `list_scene_data_cards` — list data available in a scene
- `check_data_relation` — check spatial/temporal relation between datasets
- `validate_binding_report` — validate data matching result
- `confirm_validation_snapshot` — confirm a validation snapshot
- `execute_validated_snapshot` — run InVEST on a confirmed snapshot
- `get_invest_job_status` — check job execution status
- `inspect_invest_job_outputs` — inventory job output files
- `analyze_invest_results` — deterministic raster statistics from backend
- `interpret_invest_results` — interpret analysis results

**matchingTools** — data matching workflow:
- `retrieve_input_candidates` — find candidate data for model inputs
- `finalize_data_matching` — finalize the binding report

**reportTools** — report generation:
- `write_invest_report` — generate deterministic Markdown report with number
  sanitization against result-analysis

## Skills

Skills are defined as `SKILL.md` files with YAML frontmatter. Two builtin
skills ship with the Agent:

- `agent/skills/data-matching/SKILL.md` — guides the Agent through the data
  matching workflow (candidate retrieval → binding → validation)
- `agent/skills/interpret-invest-results/SKILL.md` — guides the Agent through
  job monitoring, output inspection, and result interpretation

Skill frontmatter fields: `name`, `description`, `allowed-tools`,
`user-invocable`, `model-invocable`, `execution` (inline/isolated), `version`.

## Local Development

Backend:

```powershell
cd backend
python -m pytest
```

Agent:

```powershell
cd agent
npm test
npm run typecheck
```

Core packages:

```powershell
cd packages/agent-core
npm test
npm run typecheck

cd ../skills-core
npm test
npm run typecheck
```

Frontend:

```powershell
cd frontend
npx tsc --noEmit
```

Full Docker rebuild on server:

```bash
docker compose up -d --build backend agent-worker frontend
```

## Development Rules

- Do not let the LLM directly assemble shell commands to run InVEST.
- The backend is authoritative for model schemas, validation, execution, output
  inventories, and raster statistics.
- Domain workflow knowledge belongs in Skills. Do not hard-code user-intent
  keyword rules such as "if the user asks X, call tool Y" in the worker,
  runtime, or backend. Skills should guide the model to decide what evidence it
  needs and which tools to use.
- Tools and runtime code may enforce generic safety boundaries: permissions,
  evidence availability, workflow phase limits, path safety, deterministic
  validation, and audit logging. They should not encode InVEST-specific
  reasoning that belongs in Skills.
- Skills provide workflow guidance; tools enforce evidence, permissions, and
  workflow boundaries.
- Generated reports must cite deterministic artifacts and must not introduce
  unsupported numbers.
- Data matching and result interpretation should leave auditable artifacts.
- Agent-generated evidence that is useful to users should be visible in Data
  Hub, not only hidden in the Agent worker volume.
- Treat `packages/agent-core` as a model-agnostic runtime inspired by Claude
  Code. Changes there require extra scrutiny and should be minimal, generic,
  well-tested, and never tailored to a specific InVEST model or GSMS workflow.
- Prefer putting new domain procedures in `agent/skills/*/SKILL.md`; prefer
  putting scientific facts and validation in backend schemas/tools; modify core
  only when the issue is truly a general Agent runtime concern.

## Useful Docs

- `docs/agent-development-guidelines.md`
- `docs/agent-integration-architecture.md`
- `docs/evidence-gated-agent-development-plan.md`
- `docs/agent-session-api.md`
- `docs/docker-one-click.md`
- `docs/invest-agent-cli.md`
- `docs/real-carbon-runner-development-notes.md`

## Known Limitations

- The current robust end-to-end model is Carbon.
- Habitat Quality support is not yet complete. Schema support exists but the
  real runner is not yet wired.
- Annual Water Yield and Sediment Delivery Ratio have placeholder entries in
  the model registry.
- Large raster analysis currently reads full rasters for statistics; this may
  need chunked processing for production-scale datasets.
- Report prose sanitization is intentionally conservative. The table values are
  authoritative; free-text interpretation may be simplified if unsupported
  numbers are detected.
- Some older UI copy in the repository may still show encoding artifacts from
  earlier restoration work.
