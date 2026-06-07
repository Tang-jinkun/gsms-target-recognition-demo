#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { resolve } from 'node:path'
import { SkillLoader, SkillRegistry, SkillTool } from '@gsms/skills-core'
import { AgentRuntime } from './agent/AgentRuntime.ts'
import { OpenAICompatibleAdapter } from './model/OpenAICompatibleAdapter.ts'
import { PermissionManager } from './permissions/PermissionManager.ts'
import { builtinActionTools } from './tools/builtinTools.ts'
import { finishTool, updateGoalTool } from './tools/controlTools.ts'
import { createSkillAgentTool } from './tools/SkillAgentTool.ts'
import { ToolRegistry } from './tools/ToolRegistry.ts'

const objective = process.argv.slice(2).join(' ').trim()
if (!objective) {
  console.error('Usage: npm start -- "your objective"')
  process.exitCode = 1
} else {
  await main(objective)
}

async function main(objective: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL
  if (!apiKey || !model) {
    throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL')
  }

  const workspace = resolve(process.env.AGENT_WORKSPACE ?? process.cwd())
  const skills = new SkillRegistry()
  const loaded = await new SkillLoader({
    projectSkillsDir: resolve(workspace, '.my-agent', 'skills'),
  }).load()
  skills.replace(loaded.skills)
  for (const diagnostic of loaded.diagnostics) {
    console.error(`[skill] ${diagnostic.path ?? ''} ${diagnostic.message}`)
  }

  const registry = new ToolRegistry()
  for (const tool of builtinActionTools) registry.register(tool)
  registry.register(updateGoalTool)
  registry.register(finishTool)
  registry.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools: () =>
        registry
          .list()
          .filter(tool => tool.risk !== 'control')
          .map(tool => tool.name),
      authorizeProjectSkill: skill => confirm(`Authorize project skill "${skill.name}"?`),
      onInvocation: record => console.log(`[skill] ${record.skill}: ${record.outcome}`),
    }),
  )

  const runtime = new AgentRuntime({
    model: new OpenAICompatibleAdapter({
      apiKey,
      model,
      baseUrl: process.env.OPENAI_BASE_URL,
    }),
    tools: registry,
    skills,
    workspace,
    permissions: new PermissionManager({
      approve: async tool =>
        (await confirm(`Allow ${tool.risk} tool "${tool.name}"?`))
          ? 'allow'
          : 'deny',
    }),
    maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 20),
  })

  const result = await runtime.run(objective)
  console.log(`\nStatus: ${result.goal.status}`)
  console.log(result.goal.finalSummary ?? result.goal.progress ?? '')
  if (result.goal.evidence.length) {
    console.log(`Evidence:\n- ${result.goal.evidence.join('\n- ')}`)
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}
