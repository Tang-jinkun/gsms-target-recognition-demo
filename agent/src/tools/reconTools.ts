import type { AgentTool, AgentContext, ModelAdapter, AgentEventSink } from '@gsms/agent-core'
import { AgentRuntime, ToolRegistry } from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import { buildTool } from './buildTool.ts'

/** Minimal finish tool for subagents — no evidence gate, just sets goal status. */
const subagentFinishTool: AgentTool = {
  name: 'finish',
  description: 'Complete the investigation and return your findings.',
  risk: 'control',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: { type: 'string', description: 'Your findings and conclusions.' },
    },
  },
  async execute(input, context) {
    const summary = (input as { summary?: string }).summary ?? ''
    context.goal.status = 'completed'
    context.goal.finalSummary = summary
    return { content: `Investigation complete: ${summary.slice(0, 200)}` }
  },
}

/**
 * Creates a `run_reconnaissance` tool that spawns a read-only subagent.
 *
 * Design constraints (from agent-design-review-vs-claude-code.md § 子代理):
 * - Subagent only has access to read-only tools (risk: 'read')
 * - Subagent cannot mutate domain state or create workflow artifacts
 * - Subagent returns structured evidence; parent processes and decides
 * - Subagent is isolated: fresh ArtifactStore, fresh DomainStateStore
 *
 * @param parentTools All domain tools (will be filtered to risk: 'read')
 * @param getModel Lazy model accessor — called at subagent spawn time,
 *   so the model doesn't need to exist when the tool is created.
 */
export function createReconTool(
  parentTools: AgentTool[],
  getModel: () => ModelAdapter,
): AgentTool {
  const readOnlyTools = parentTools.filter(t => t.risk === 'read')

  return buildTool({
    name: 'run_reconnaissance',
    description: [
      'Spawn a read-only subagent to investigate a question in depth.',
      'Use for: summarizing data cards, comparing candidate sets, analyzing schema coverage.',
      'The subagent can only call read-only tools and returns structured findings.',
      'It cannot modify workflow state, validate, confirm, or execute anything.',
    ].join(' '),
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'What the subagent should investigate. Be specific about what to find and how to structure the output.',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names the subagent may call. Defaults to all read-only tools.',
        },
        maxTurns: {
          type: 'number',
          description: 'Maximum turns for the subagent (default 5, max 10).',
          minimum: 1,
          maximum: 10,
        },
      },
    },
    async execute(input, context, onProgress) {
      const parsed = input as {
        prompt: string
        allowedTools?: string[]
        maxTurns?: number
      }

      const maxTurns = Math.min(parsed.maxTurns ?? 5, 10)

      // Resolve allowed tools — filter to read-only subset
      let tools = readOnlyTools
      if (parsed.allowedTools?.length) {
        const allowed = new Set(parsed.allowedTools)
        tools = readOnlyTools.filter(t => allowed.has(t.name))
        if (tools.length === 0) {
          return {
            content: JSON.stringify({
              error: 'No matching read-only tools found',
              requested: parsed.allowedTools,
              availableReadOnly: readOnlyTools.map(t => t.name),
            }),
          }
        }
      }

      // Build isolated subagent — fresh artifacts, fresh domain state, no skills
      // Include subagentFinishTool (no evidence gate) so the subagent can signal completion
      const subRegistry = new ToolRegistry([...tools, subagentFinishTool])
      const emptySkills = new SkillRegistry()

      // Surface subagent activity to the parent as tool.progress events, so the
      // UI shows live sub-steps instead of one opaque long-running spinner.
      const eventSink: AgentEventSink | undefined = onProgress
        ? {
            async emit(event) {
              if (
                (event.eventType === 'tool.completed' || event.eventType === 'model.responded') &&
                event.summary
              ) {
                onProgress({ message: `侦察子代理：${event.summary}` })
              }
            },
          }
        : undefined

      const runtime = new AgentRuntime({
        model: getModel(),
        tools: subRegistry,
        skills: emptySkills,
        workspace: context.workspace,
        maxTurns,
        signal: context.signal,
        eventSink,
      })

      const result = await runtime.run(parsed.prompt)

      // The subagent signals completion via subagentFinishTool, which writes its
      // conclusion to goal.finalSummary. Prefer that; fall back to the last
      // assistant text only if finish was never called.
      const lastAssistantText = result.messages
        .filter(m => m.role === 'assistant' && m.content.trim())
        .at(-1)?.content

      const findings =
        result.goal.finalSummary?.trim() ||
        lastAssistantText ||
        '(subagent produced no output)'

      // Surface subagent artifacts as structured UNVERIFIED evidence.
      // These are NOT copied into the parent's ArtifactStore — the parent's
      // evidence gate must only count artifacts produced by the parent's own
      // deterministic tools.  The parent model is expected to re-run a
      // deterministic tool (retrieve_input_candidates, check_data_relation,
      // assess_scene_model_readiness) to convert any claim into parent-scope
      // evidence.  Only type/data/metadata are surfaced; createdBy is stripped
      // to prevent the model from echoing forged 'user' claims.
      const unverifiedEvidence = result.artifacts.map(a => ({
        type: a.type,
        data: a.data,
        metadata: a.metadata,
      }))

      return {
        content: JSON.stringify({
          findings,
          turnsUsed: result.goal.turnCount,
          status: result.goal.status,
          diagnostics: result.diagnostics,
          unverifiedEvidence,
          verificationRequired: unverifiedEvidence.length > 0,
          ...(unverifiedEvidence.length > 0 ? {
            note: 'Subagent findings are UNVERIFIED. The parent must re-run a deterministic tool '
              + '(retrieve_input_candidates / check_data_relation / assess_scene_model_readiness) '
              + 'to convert any claim into parent-scope evidence.',
          } : {}),
        }),
        // Do NOT set artifacts — subagent evidence must not enter the parent's
        // Evidence Ledger or influence the finish tool's evidence gate.
      }
    },
  })
}
