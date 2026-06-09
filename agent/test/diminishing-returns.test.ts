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
    id: 'session-np',
    scene_id: 'scene-1',
    status: 'queued',
    domain_state: { sceneId: 'scene-1' },
    artifacts: [],
    model_config: { model_id: 'fake' },
  }
}

test('agent stops on diminishing returns before reaching maxTurns', async () => {
  const current = session()
  const events: string[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Do something impossible' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/events') && init?.method === 'POST') {
      events.push(JSON.parse(String(init.body)).event_type)
      return response({ id: events.length, type: events.at(-1), data: {} }, 201)
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      current.status = body.action === 'start' ? 'running' : (body.action === 'fail' ? 'failed' : 'idle')
      return response(current)
    }
    // GSMS API calls from list_invest_models etc. — return empty
    return response([])
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-dr-'))
  try {
    // Alternating tools that produce no artifacts — avoids the cycle detector
    // but still triggers diminishing returns (no new artifacts per turn).
    const responses = Array.from({ length: 20 }, (_, i) => ({
      content: '',
      toolCalls: [{
        id: String(i),
        name: i % 2 === 0 ? 'update_goal' : 'list_invest_models',
        input: i % 2 === 0 ? { progress: 'Still trying...' } : {},
      }],
    }))
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () => new FakeModelAdapter(responses),
      maxTurns: 20,
    })

    assert.equal(await worker.runOnce(), true)
    // Should have stopped with 'fail' (no-progress), not run all 20 turns
    assert.equal(current.status, 'failed')
    // The AGENT_NO_PROGRESS diagnostic event should have been emitted
    assert.ok(events.includes('diagnostic.created'), 'AGENT_NO_PROGRESS diagnostic emitted')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('agent does not trigger diminishing returns when producing artifacts', async () => {
  const current = session()
  const actions: string[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Do work' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'tool.completed', data: {} }, 201)
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = body.action === 'start' ? 'running' : 'idle'
      return response(current)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-dr2-'))
  try {
    // First call produces an artifact (via finish), second call finishes normally
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
      maxTurns: 20,
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'complete'])
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
