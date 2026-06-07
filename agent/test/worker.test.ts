import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FakeModelAdapter } from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import { AgentSessionApiClient, InvestAgentWorker } from '../src/index.ts'
import type { PersistedAgentSession } from '../src/worker/AgentSessionApiClient.ts'

function session(): PersistedAgentSession {
  return {
    id: 'session-1',
    scene_id: 'scene-1',
    status: 'queued',
    domain_state: { sceneId: 'scene-1' },
    artifacts: [],
    model_config: { model_id: 'fake' },
  }
}

test('worker claims a queued session and checkpoints a completed Agent run', async () => {
  const actions: string[] = []
  const current = session()
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Assess carbon' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = body.action === 'start' ? 'running' : 'idle'
      return response(current)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [{ id: '1', name: 'finish', input: { summary: 'Done', evidence: ['scene-1'] } }],
          },
        ]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'complete'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('worker requests confirmation and pauses before a write tool', async () => {
  const actions: string[] = []
  const confirmations: Array<{ id: string; status: string; payload: Record<string, unknown> }> = []
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    jobId: 'job-1',
    phase: 'results-ready-for-interpretation',
  }
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Write report' }])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = 'running'
      return response(current)
    }
    if (url.endsWith('/confirmations') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      confirmations.push({ id: 'c1', status: 'pending', payload: body.payload })
      current.status = 'awaiting_confirmation'
      return response(confirmations[0])
    }
    if (url.endsWith('/confirmations')) return response(confirmations)
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [
              {
                id: '1',
                name: 'write_invest_report',
                input: { resultSummary: 'Evidence-backed summary' },
              },
            ],
          },
        ]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start'])
    assert.equal(confirmations[0]?.payload.tool, 'write_invest_report')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('worker does not fail a session when another worker wins the claim', async () => {
  const actions: string[] = []
  const current = session()
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      return response({ detail: 'Session is already running.' }, 409)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () => new FakeModelAdapter([]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
