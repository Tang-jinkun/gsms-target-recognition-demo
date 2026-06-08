# Phase 0 + Phase 1 Implementation Plan

Based on `docs/development-plan-0608.md` and the architecture audit.

## Phase 0: Architecture Boundary Audit

### 0.1 Fix domain leak in controlTools.ts

**Problem:** `finish` tool in `packages/agent-core` hard-codes GSMS tool names.

**Fix:** Replace domain-specific error message with generic one. The evidence gate logic itself is generic (check for non-control artifacts), only the error message leaks.

```ts
// Before
content: 'Cannot finish: no domain evidence produced. Call domain tools (list_scene_data_cards, get_invest_model_schema, etc.) first.'

// After
content: 'Cannot finish: no evidence artifacts produced. Gather domain evidence before finishing.'
```

**File:** `packages/agent-core/src/tools/controlTools.ts`

### 0.2 Remove domain logic from workflowBoundary.ts

**Problem:** `matchingPhaseAllows()` checks specific artifact types (`model-input-schema`, `gsms-scene-data-cards`, `candidate-set`, `binding-report`, `validation-report`, `confirmation-record`). This is domain knowledge in what should be a generic boundary layer.

**Fix:** Move artifact-type-specific visibility logic into a **Gate** that the tools themselves invoke. `workflowBoundary.ts` should only enforce:
- Phase group (matching vs execution)
- Execution phase hard gates (unchanged)
- finish evidence gate (generic: any non-control artifact exists)

The tool visibility for matching group becomes: **all tools visible, tools internally call their Gate before producing output.**

**File:** `agent/src/workflowBoundary.ts`

### 0.3 Standardize artifact metadata

**Problem:** Inconsistent metadata across artifacts:
- `validation-report`: only `{ modelId }`, missing `sceneId` and `matchingContextId`
- `confirmation-record`: no metadata at all
- `model-job`: no metadata at all
- `job-status`: missing `modelId`

**Fix:** Add missing metadata fields to each tool's artifact creation. Define a helper to ensure consistency.

**Files:** `agent/src/tools/gsmsTools.ts`

### 0.4 Add ArtifactContext helper

**Problem:** Each tool manually constructs metadata, leading to inconsistencies.

**Fix:** Add a `matchingArtifactContext(context)` helper that returns `{ sceneId, modelId, matchingContextId }` from domain state. Tools call it instead of manually reading state.

**File:** `agent/src/tools/matchingTools.ts` (or new `agent/src/tools/artifactContext.ts`)

---

## Phase 1: Carbon Data Matching Closed Loop

### 1.1 Create DataMatchingGate

**Location:** `agent/src/gates/dataMatchingGate.ts` (new file)

**Logic:**
```ts
interface DataMatchingGateResult {
  passed: boolean
  status: 'ready_for_validation' | 'missing_input' | 'needs_review' | 'not_attempted'
  blockingReasons: string[]
  slotStatuses: SlotStatus[]
}

function checkDataMatchingGate(context: AgentContext): DataMatchingGateResult {
  // 1. Binding Report exists?
  // 2. matchingContextId still current?
  // 3. Every required slot has explicit status?
  // 4. Selected assets exist in current scene?
  // 5. Selected assets belong to candidate set?
  // 6. No required input silently missing?
  // 7. No unresolved ambiguity as certain match?
  // 8. No blocking relation check failed?
  // 9. Unchecked required relation → needs_review, not ready
  // 10. recommendedNextAction consistent with status?
}
```

### 1.2 Integrate DataMatchingGate into finalize_data_matching

**Current:** `finalize_data_matching` builds the binding report and returns it.

**New:** `finalize_data_matching` builds the report, then runs `DataMatchingGate`. The gate result is embedded in the binding-report artifact. If status is `missing_input` or `needs_review`, the tool still succeeds (report is created) but the status reflects reality.

**File:** `agent/src/tools/matchingTools.ts`

### 1.3 DataMatchingGate blocks validation entry

**Current:** `validate_binding_report` checks if a binding report exists.

**New:** `validate_binding_report` also runs `DataMatchingGate` on the existing report. If gate status is not `ready_for_validation`, validation is rejected with a clear message.

**File:** `agent/src/tools/gsmsTools.ts`

### 1.4 Remove domain artifact checks from workflowBoundary.ts

After Phase 1, `matchingPhaseAllows` becomes:

```ts
function matchingPhaseAllows(): boolean {
  return true  // all tools visible, gates enforce quality
}
```

This is the correct design: **tools are visible, but they refuse to produce bad output.**

### 1.5 Update SKILL.md

Update `data-matching/SKILL.md` to document:
- The DataMatchingGate and what it checks
- That tools will reject invalid calls with structured errors
- That the agent should read gate errors and recover

### 1.6 Tests

**New test file:** `agent/test/dataMatchingGate.test.ts`

| Test | Expected |
|------|----------|
| Complete Carbon data | `ready_for_validation` |
| Missing carbon pools | `missing_input` |
| Ambiguous baseline/alternate | `needs_review` |
| Asset outside candidate set | `missing_input` (selected not in candidates) |
| Stale matchingContextId | `not_attempted` |
| Unchecked required relation | `needs_review` |
| Model list only (no matching) | `not_attempted` |

---

## File Change Summary

| File | Phase | Change |
|------|-------|--------|
| `packages/agent-core/src/tools/controlTools.ts` | 0.1 | Remove domain tool names from error message |
| `agent/src/workflowBoundary.ts` | 0.2 | Simplify matchingPhaseAllows to return true |
| `agent/src/tools/gsmsTools.ts` | 0.3, 1.3 | Fix metadata, integrate gate into validate |
| `agent/src/tools/matchingTools.ts` | 1.2 | Integrate DataMatchingGate into finalize |
| `agent/src/gates/dataMatchingGate.ts` | 1.1 | NEW: DataMatchingGate implementation |
| `agent/skills/data-matching/SKILL.md` | 1.5 | Document gate behavior |
| `agent/test/dataMatchingGate.test.ts` | 1.6 | NEW: Gate tests |
| `agent/test/worker.test.ts` | 0.2 | Update phase filter tests |

## Order of Operations

1. **0.1** Fix controlTools.ts domain leak (tiny, safe)
2. **0.3 + 0.4** Standardize metadata + helper (foundation for gate)
3. **1.1** Create DataMatchingGate (new file, no existing code affected)
4. **1.2** Integrate gate into finalize_data_matching
5. **1.3** Integrate gate into validate_binding_report
6. **0.2** Simplify workflowBoundary.ts (now safe because gates enforce quality)
7. **1.5** Update SKILL.md
8. **1.6** Write tests
9. Run all tests, rebuild docker, verify
