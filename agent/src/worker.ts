#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { SkillLoader, SkillRegistry } from '@gsms/skills-core'
import { InvestAgentWorker } from './worker/InvestAgentWorker.ts'
import { createIntentClassifier, intentClassifierConfigFromEnv } from './intent/createIntentClassifier.ts'

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const gsmsUrl = (process.env.GSMS_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '')
const proxyToken = process.env.GSMS_AGENT_PROXY_TOKEN ?? ''
const workspace = resolve(process.env.INVEST_AGENT_WORKSPACE ?? process.cwd())
const pollMs = Number(process.env.INVEST_AGENT_WORKER_POLL_MS ?? 1500)

if (!proxyToken) throw new Error('Set GSMS_AGENT_PROXY_TOKEN before starting the Agent Worker.')

const builtinsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const loaded = await new SkillLoader({ projectSkillsDir: builtinsDir }).load()
const skills = new SkillRegistry()
skills.replace(loaded.skills.map(skill => ({ ...skill, source: 'builtin' as const })))
const experimentalRecon = process.env.INVEST_AGENT_EXPERIMENTAL_RECON === '1'
const worker = new InvestAgentWorker({
  gsmsUrl,
  proxyToken,
  workspace,
  skills,
  experimentalRecon,
  intentClassifierFactory: session => createIntentClassifier(intentClassifierConfigFromEnv(process.env, {
    model: String(session.model_config.model_id ?? 'gsms-default'),
    baseUrl: `${gsmsUrl}/api/agent`,
    apiKey: proxyToken,
  })),
})

do {
  const worked = await worker.runOnce()
  if (once) break
  if (!worked) await delay(pollMs)
} while (true)
