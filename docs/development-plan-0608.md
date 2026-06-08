# Evidence-Gated InVEST Agent Development Plan

## Purpose

GSMS is building an Agent that can understand a natural-language ecological
question, investigate available data, configure and run an InVEST model, and
explain the results. The Agent must remain capable of choosing its own
investigation path, while scientific claims and irreversible actions remain
grounded in deterministic evidence.

The target architecture is:

```text
LLM chooses business judgments and investigation paths
Skill provides domain methods, procedures, examples, and recovery guidance
Tool / Primitive obtains facts or performs a deterministic action
Artifact records auditable evidence
Gate validates a critical conclusion or stage transition
Workflow Boundary enforces prerequisites that cannot be bypassed
```

This plan deliberately starts with concrete Gates. Do not build a general
claim language, rules DSL, or universal Claim Validator until several concrete
Gates have demonstrated stable shared requirements.

## Design Rules

### Flexible exploration, strict transitions

The Agent may inspect data before a model schema, or a schema before data. A
Gate must not require one fixed tool-call sequence. However, the Agent cannot
claim that a model is ready, enter validation, execute a job, or publish a
scientific report until the evidence required for that transition exists.

### Skills and Gates are complementary

Skills teach the model how a domain task should be investigated:

- which factors deserve attention;
- how to reason about candidate data;
- which scientific relationships may need checking;
- how to explain uncertainty and risk;
- how to recover from missing or ambiguous evidence.

Gates enforce conditions that must never depend on model compliance:

- selected assets exist and belong to the current scene;
- evidence belongs to the current data and schema context;
- blocking validation failures cannot be described as passed;
- execution requires a valid snapshot and explicit user confirmation;
- report numbers originate from deterministic result analysis.

Domain procedure belongs in Skills. Deterministic facts belong in backend
schemas and Tools. InVEST-specific Gates belong in the Agent host, not in
`packages/agent-core`.

### Guardrails do not become a second Workflow

A Gate checks evidence and state validity. It does not decide which model the
user meant, select candidate data, assign confidence, write ecological
interpretation, or force the Agent through one prescribed tool sequence.

## Responsibility Boundaries

| Responsibility | Owner |
| --- | --- |
| Agent loop, generic tool calling, generic permissions | `packages/agent-core` |
| Skill loading, registration, and execution | `packages/skills-core` |
| InVEST investigation methods and procedures | `agent/skills` |
| GSMS API calls and deterministic scientific checks | Agent Tools and backend |
| Evidence creation and persistence | Artifact layer |
| InVEST-specific transition checks | Agent-host Gates |
| Current-request restrictions and non-bypassable prerequisites | Workflow Boundary |

`packages/agent-core` must remain model- and domain-agnostic. Changes there
require evidence that the behavior is useful for Agents outside GSMS.

## Artifact Context

Evidence used by a Gate must identify the context in which it was produced.
The first implementation should converge on metadata equivalent to:

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

For matching evidence:

```text
matchingContextId =
  hash(scene ID + model ID + model schema version + sorted asset fingerprints)
```

Old evidence remains available for audit, but cannot support a current decision
after its context changes.

## Phase 0: Architecture Boundary Audit

### Goal

Separate responsibilities currently mixed inside workflow filtering and stop
adding domain behavior to generic runtime code.

### Work and acceptance

- Classify each existing check as Skill guidance, Tool validation, Gate,
  Workflow Boundary, permission control, or generic runtime behavior.
- Remove GSMS and InVEST assumptions from `packages/agent-core`.
- Reduce Workflow Boundary behavior to current-request restrictions and
  non-bypassable stage prerequisites.
- Standardize Artifact context metadata.
- Ensure Workflow filtering does not encode a fixed domain tool sequence.
- Ensure current and stale evidence can be distinguished deterministically.

## Phase 1: Carbon Data Matching Closed Loop

### Goal

Make Carbon matching the first complete evidence-gated workflow while
preserving the Agent's freedom to investigate.

Stable matching artifacts:

```text
model-input-schema
data-card
candidate-set
relation-check
binding-report
```

Each matching artifact must carry the current scene, model, and
`matchingContextId`.

### DataMatchingGate

The initial Gate checks:

1. A Binding Report exists.
2. Its `matchingContextId` is still current.
3. Every required slot has an explicit status.
4. Every selected asset exists in the current scene.
5. Every selected asset belongs to the persisted candidate set for that slot.
6. No required input is silently missing.
7. No unresolved ambiguity is represented as a certain match.
8. No blocking relation check has failed.
9. If a required relation was not checked, the result is `needs_review`, not
   `ready_for_validation`.
10. The recommended next action is consistent with the Gate result.

The Gate validates the completed Binding Report. It must not require the LLM to
call tools in one exact order.

### Tests

- Complete Carbon data produces `ready_for_validation`.
- Missing carbon pools data produces `missing_input`.
- Ambiguous baseline and alternate rasters produce `needs_review`.
- A selected asset outside the candidate set is rejected.
- Evidence from another scene or matching context is rejected.
- Changing an asset fingerprint invalidates the old Binding Report.
- A model list alone cannot support a "Carbon is runnable" conclusion.

## Phase 2: Data Sufficiency and Runnable Assessment

### Goal

Support questions such as "Which InVEST models can this scene run?" without
conflating model registration, scientific relevance, data sufficiency, and
execution readiness.

### Concrete Gates

- `DataSufficiencyGate` checks whether current-scene evidence covers a model's
  required data inputs. It does not run official validation or assert runner
  availability.
- `RunnableGate` combines data sufficiency, required blocking relationship
  checks, runner availability, and required validation/confirmation state when
  the claim is "runnable now".

The Agent and UI must distinguish:

| Conclusion | Meaning |
| --- | --- |
| `scientifically_relevant` | The model can address the ecological question |
| `data_sufficient` | Required data appears available |
| `ready_for_validation` | Matching evidence can enter official validation |
| `runnable` | All execution prerequisites are currently satisfied |

Tests must prove that model registration, runner availability, and data
sufficiency cannot independently support a `runnable` conclusion.

## Phase 3: Validation, Snapshot, and Confirmation

### ValidationGate

Checks that the Binding Report passed `DataMatchingGate`, official InVEST
`validate(args)` ran, the result belongs to an immutable input snapshot, no
blocking errors remain, and input or parameter changes invalidate the result.

### ExecutionGate

Checks that the Validation Snapshot passed, explicit user confirmation belongs
to the same snapshot, the current request permits execution, the runner is
available, and model version, inputs, and parameters have not changed.

Use distinct identifiers:

```text
matchingContextId
bindingReportId
validationSnapshotId
userConfirmationId
jobId
```

Tests must cover stale confirmation, "validate but do not execute", failed
validation, and duplicate execution prevention.

## Phase 4: Result Analysis and Report Trust

### ReportGate

Checks that the job succeeded, outputs were inventoried, fingerprints are
current, `result-analysis` belongs to those outputs, referenced Metric IDs
exist, report numbers come from deterministic analysis, and unclassified
outputs do not receive unsupported ecological meaning.

Engineering work:

- analyze large rasters in windows or chunks;
- publish useful intermediate Artifacts and reports to Data Hub;
- prevent old narrative-only reports from satisfying deterministic report
  requirements.

## Phase 5: Generalize Only Proven Repetition

After the concrete Gates exist, evaluate their shared structure. A small shared
result type may be justified:

```ts
interface GateResult {
  passed: boolean
  status: string
  blockingReasons: GateReason[]
  evidenceArtifactIds: string[]
  nextActions: NextAction[]
}
```

Do not introduce a general Claim Validator until concrete Gates show stable,
repeated requirements. Avoid a claim DSL, arbitrary evidence rules engine, or
new global state machine.

## Skill Package Roadmap

Skills should evolve from single prompt files into focused capability packages:

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

Skills own investigation methods, candidate reasoning dimensions, relation
check recommendations, uncertainty communication, and recovery guidance.
Skills must not fabricate Artifacts, declare that a Gate passed, expand
permissions, bypass confirmation, or turn a recommended sequence into the only
allowed sequence.

## Delivery Order

| Priority | Delivery |
| --- | --- |
| P0 | Architecture boundary audit and domain-leakage list |
| P0 | Carbon `DataMatchingGate` and current-context isolation |
| P0 | Complete, missing, ambiguous, and stale-evidence matching tests |
| P1 | `DataSufficiencyGate` and `RunnableGate` |
| P1 | `ValidationGate` and `ExecutionGate` |
| P2 | `ReportGate`, chunked analysis, and Data Hub visibility |
| P3 | Shared Gate interfaces based on proven repetition |

## Immediate Next Milestone

Do not continue expanding "flexible workflow" as a single abstraction.

The next milestone is:

> Preserve flexible LLM investigation while implementing Carbon
> `DataMatchingGate`, so only a Binding Report supported by complete,
> current-context evidence can enter validation.
