import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ArtifactStore,
  DomainStateStore,
  PermissionManager,
  readFileTool,
  writeFileTool,
  type AgentContext,
  type GoalState,
} from '../src/index.ts'

function context(workspace: string): AgentContext {
  const goal: GoalState = {
    objective: 'test',
    status: 'active',
    turnCount: 1,
    maxTurns: 5,
    evidence: [],
    remainingIssues: [],
    startedAt: new Date().toISOString(),
  }
  return {
    workspace,
    goal,
    artifacts: new ArtifactStore(),
    domainState: new DomainStateStore(),
  }
}

test('workspace tools reject path traversal', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-path-'))
  await assert.rejects(
    readFileTool.execute({ path: '../outside.txt' }, context(workspace)),
    /escapes workspace|ENOENT/,
  )
})

test('write tool writes inside workspace after approval policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-write-'))
  await mkdir(join(workspace, 'sub'))
  const ctx = context(workspace)
  const permissions = new PermissionManager({ approve: () => 'allow' })
  assert.equal(await permissions.check(writeFileTool, {}, ctx), 'allow')

  await writeFileTool.execute({ path: 'sub/result.txt', content: 'ok' }, ctx)
  assert.equal(await readFile(join(workspace, 'sub/result.txt'), 'utf8'), 'ok')
})

test('write and execute tools are denied without explicit approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-deny-'))
  const permissions = new PermissionManager()
  assert.equal(await permissions.check(writeFileTool, {}, context(workspace)), 'deny')
})
