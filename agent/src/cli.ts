#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAICompatibleAdapter, ToolRegistry, type AgentTool } from '@gsms/agent-core'
import { SkillLoader, SkillRegistry } from '@gsms/skills-core'
import { GsmsClient } from './gsms/GsmsClient.ts'
import { createGsmsTools } from './tools/gsmsTools.ts'
import { createMatchingTools } from './tools/matchingTools.ts'
import { createReportTools } from './tools/reportTools.ts'
import { createReconTool } from './tools/reconTools.ts'
import { GsmsBootstrapClient, type GsmsScene } from './cli/GsmsBootstrapClient.ts'
import { InvestAgentSession, registerSessionControlTools } from './cli/InvestAgentSession.ts'
import { parseCliArguments, resolveCliConfig } from './cli/config.ts'
import { createIntentClassifier } from './intent/createIntentClassifier.ts'

const HELP = `Usage: invest-agent [options]

Options:
  --gsms-url URL       GSMS backend URL (default: http://127.0.0.1:8000)
  --scene ID           GSMS scene ID; prompts when omitted
  --workspace PATH     Agent report/artifact workspace
  --model ID           OpenAI-compatible model ID
  --base-url URL       OpenAI-compatible API base URL
  --api-key KEY        API key (prefer INVEST_AGENT_API_KEY env var)
  --intent-classifier-model ID       Override model ID for intent classification
  --intent-classifier-base-url URL   Override classifier API base URL
  --intent-classifier-api-key KEY    Override classifier API key
  --disable-intent-classifier        Disable LLM fallback intent classification
  --max-turns N        Maximum autonomous turns per user message
  --yes, -y            Approve write/execute tools without prompting
  --help, -h           Show this help

Environment:
  GSMS_URL, GSMS_SCENE_ID, INVEST_AGENT_WORKSPACE
  INVEST_AGENT_MODEL, INVEST_AGENT_BASE_URL, INVEST_AGENT_API_KEY
  INVEST_AGENT_INTENT_CLASSIFIER_MODEL, INVEST_AGENT_INTENT_CLASSIFIER_BASE_URL
  INVEST_AGENT_INTENT_CLASSIFIER_API_KEY, INVEST_AGENT_DISABLE_INTENT_CLASSIFIER
  GSMS_AGENT_PROXY_TOKEN
  OPENAI_MODEL, OPENAI_BASE_URL, OPENAI_API_KEY
`

await main().catch(error => {
  console.error(`invest-agent: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }
  const config = await resolveCliConfig(args)
  const bootstrap = new GsmsBootstrapClient(config.gsmsUrl)
  await bootstrap.health()
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const scene = await selectScene(bootstrap, config.sceneId, rl)
    const workspace = resolve(config.workspace)
    const skills = await loadSkills(workspace)
    const registry = new ToolRegistry()
    const gsmsClient = new GsmsClient({ baseUrl: config.gsmsUrl })
    const model = new OpenAICompatibleAdapter({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.modelBaseUrl,
    })
    const intentClassifierModel = createIntentClassifier({
      model: config.intentClassifierModel,
      baseUrl: config.intentClassifierBaseUrl,
      apiKey: config.intentClassifierApiKey,
    })
    const coreTools: AgentTool[] = [
      ...createGsmsTools(gsmsClient),
      ...createMatchingTools(),
      ...createReportTools(gsmsClient),
    ]
    const domainTools: AgentTool[] = [...coreTools]
    if (config.experimentalRecon) {
      domainTools.push(createReconTool(coreTools, () => model))
    }
    for (const tool of domainTools) registry.register(tool)
    registerSessionControlTools(
      registry,
      skills,
      () => domainTools.map(tool => tool.name),
      message => console.log(`[skill] ${message}`),
    )
    const session = new InvestAgentSession({
      model,
      tools: registry,
      skills,
      workspace,
      sceneId: scene.id,
      maxTurns: config.maxTurns,
      intentClassifierModel,
      approve: async (tool: AgentTool) => {
        if (config.yes) return 'allow'
        const answer = await rl.question(`Allow ${tool.risk} tool "${tool.name}"? [y/N] `)
        return /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny'
      },
    })
    console.log(`Connected to GSMS: ${config.gsmsUrl}`)
    console.log(`Scene: ${scene.name} (${scene.id})`)
    console.log(`Model: ${config.model} @ ${config.modelBaseUrl}`)
    if (config.intentClassifierModel) {
      console.log(`Intent classifier: ${config.intentClassifierModel} @ ${config.intentClassifierBaseUrl}`)
    }
    console.log('Commands: /status, /scenes, /help, /exit')
    while (true) {
      const message = (await rl.question('\nyou> ')).trim()
      if (!message) continue
      if (message === '/exit' || message === '/quit') break
      if (message === '/help') {
        console.log('Commands: /status, /scenes, /help, /exit')
        continue
      }
      if (message === '/status') {
        console.log(JSON.stringify(session.status(), null, 2))
        continue
      }
      if (message === '/scenes') {
        printScenes(await bootstrap.listScenes())
        continue
      }
      const result = await session.send(message)
      console.log(`\nagent> ${result.goal.finalSummary ?? result.goal.progress ?? result.goal.status}`)
      if (result.goal.evidence.length) console.log(`evidence> ${result.goal.evidence.join(', ')}`)
      if (result.goal.remainingIssues.length) {
        console.log(`remaining> ${result.goal.remainingIssues.join('; ')}`)
      }
      for (const diagnostic of result.diagnostics) {
        console.log(`[${diagnostic.severity}] ${diagnostic.message}`)
      }
    }
  } finally {
    rl.close()
  }
}

async function loadSkills(workspace: string): Promise<SkillRegistry> {
  const builtinsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  const builtinLoad = await new SkillLoader({ projectSkillsDir: builtinsDir }).load()
  const builtinSkills = builtinLoad.skills.map(skill => ({ ...skill, source: 'builtin' as const }))
  const loaded = await new SkillLoader({
    projectSkillsDir: resolve(workspace, '.my-agent', 'skills'),
    builtinSkills,
  }).load()
  for (const diagnostic of [...builtinLoad.diagnostics, ...loaded.diagnostics]) {
    console.error(`[skill:${diagnostic.severity}] ${diagnostic.path ?? ''} ${diagnostic.message}`)
  }
  const registry = new SkillRegistry()
  registry.replace(loaded.skills)
  return registry
}

async function selectScene(
  client: GsmsBootstrapClient,
  requested: string | undefined,
  rl: ReturnType<typeof createInterface>,
): Promise<GsmsScene> {
  const scenes = await client.listScenes()
  if (!scenes.length) throw new Error('GSMS has no scenes. Create a scene before starting the Agent.')
  if (requested) {
    const scene = scenes.find(item => item.id === requested)
    if (!scene) throw new Error(`GSMS scene not found: ${requested}`)
    return scene
  }
  if (scenes.length === 1) return scenes[0]!
  printScenes(scenes)
  const answer = (await rl.question('Select scene number or ID: ')).trim()
  const byIndex = scenes[Number(answer) - 1]
  const scene = byIndex ?? scenes.find(item => item.id === answer)
  if (!scene) throw new Error(`Invalid scene selection: ${answer}`)
  return scene
}

function printScenes(scenes: GsmsScene[]): void {
  for (const [index, scene] of scenes.entries()) {
    console.log(`${index + 1}. ${scene.name} (${scene.id})${scene.region ? ` - ${scene.region}` : ''}`)
  }
}
