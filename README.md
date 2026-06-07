# GSMS InVEST Agent Workbench

GSMS is a local WebGIS workbench and domain Agent for running and explaining
InVEST ecosystem-service models. The current development focus is an Agent that
can understand a user's natural-language task, select a suitable InVEST model,
match scene data, validate inputs, execute a confirmed run, and explain the
outputs using deterministic analysis rather than invented LLM numbers.

The first supported real workflow is InVEST Carbon on the Willamette sample
data. Habitat Quality and additional InVEST models are planned after the Carbon
chain is stable.

## What We Are Building

The intended responsibility split is:

- `frontend/`: Next.js WebGIS workbench, scene UI, Data Hub, map, and Agent chat.
- `backend/`: FastAPI service, scene/data/job APIs, InVEST execution, result
  analysis, and persistent Data Hub metadata.
- `agent/`: InVEST Agent worker and CLI. It talks to the backend and an
  OpenAI-compatible model API.
- `packages/agent-core`: model/tool runtime, permissions, artifacts, workflow
  state, and loop guards.
- `packages/skills-core`: clean-room Skills infrastructure.
- `sample_data/`: fixed sample inputs for Carbon testing.
- `docs/`: implementation notes, acceptance plans, and development guidelines.

The Agent should reason and plan, but scientific and filesystem operations are
performed by deterministic backend tools. The LLM must not directly run InVEST
or fabricate output statistics.

## Current Branch Focus

The active feature branch is:

```text
feat/deterministic-result-analysis
```

This branch adds and hardens the result interpretation chain:

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
- `docs/agent-session-api.md`
- `docs/docker-one-click.md`
- `docs/invest-agent-cli.md`
- `docs/real-carbon-runner-development-notes.md`

## Known Limitations

- The current robust end-to-end model is Carbon.
- Habitat Quality support is not yet complete.
- Large raster analysis currently reads full rasters for statistics; this may
  need chunked processing for production-scale datasets.
- Report prose sanitization is intentionally conservative. The table values are
  authoritative; free-text interpretation may be simplified if unsupported
  numbers are detected.
- Some older UI copy in the repository may still show encoding artifacts from
  earlier restoration work.
