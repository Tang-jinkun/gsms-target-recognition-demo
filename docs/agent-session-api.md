# Agent Session API

GSMS persists Agent conversations independently from the CLI or browser. A
session belongs to one Scene and stores domain state, artifacts, model metadata,
messages, events, and pending confirmations.

## Session Lifecycle

```text
idle
  -> queued                  user message accepted
  -> running                 Agent Worker claims queued session
  -> awaiting_confirmation   Agent requests a protected action
  -> queued                  user approves; Worker may resume
  -> idle                    run completes or user rejects confirmation
  -> failed                  execution failure
```

Only one user message may be active per session. Additional messages are
rejected while the session is queued, running, or awaiting confirmation.

## Browser-Facing Endpoints

```text
POST /api/agent/sessions
GET  /api/agent/sessions?scene_id=<id>
GET  /api/agent/sessions/{id}
GET  /api/agent/sessions/{id}/messages
POST /api/agent/sessions/{id}/messages
GET  /api/agent/sessions/{id}/events?after_id=<event-id>
POST /api/agent/sessions/{id}/confirmations/{confirmation-id}
```

The browser polls events incrementally using `after_id`. A later phase may add
SSE without changing persisted event semantics.

## Worker-Facing Endpoints

```text
GET  /api/agent/sessions?status=queued
POST /api/agent/sessions/{id}/checkpoint
POST /api/agent/sessions/{id}/events
POST /api/agent/sessions/{id}/confirmations
POST /api/agent/sessions/{id}/confirmations/{confirmation-id}/consume
```

The Worker uses checkpoints to persist:

- `start`, `complete`, or `fail` state transitions
- current Agent domain state
- serialized artifacts
- assistant messages
- failure details

During a run, the Worker also appends auditable action events in real time. These
events describe actions and outcomes without storing hidden model reasoning:

- run start, pause, completion, and failure
- selected tools and tool start/completion/failure
- workflow state changes and created artifacts
- diagnostics and detected tool-call loops

Tool inputs are truncated and common secret fields are redacted before events
leave the Agent runtime.

Protected operations create a confirmation request instead of executing
immediately. Approval moves the session back to `queued`, allowing a Worker to
resume it. Before executing the protected tool, the Worker consumes the exact
approved confirmation once, matching both tool name and structured input.

## Start The Worker

```powershell
cd E:\Github\GSMS
$env:GSMS_AGENT_PROXY_TOKEN = "choose-a-long-random-token"
.\scripts\start_invest_agent_worker.ps1
```

Use `-Once` to process at most one queued session. Multiple Workers may poll
the same queue; only the Worker that successfully transitions a session from
`queued` to `running` may checkpoint its failure.
