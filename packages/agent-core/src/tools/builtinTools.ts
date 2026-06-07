import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AgentTool } from '../types.ts'
import {
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
} from './workspace.ts'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_CHARS = 40_000

export const readFileTool: AgentTool = {
  name: 'read_file',
  description: 'Read a UTF-8 file inside the workspace',
  risk: 'read',
  inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
  async execute(input, context) {
    const { path } = z.object({ path: z.string() }).parse(input)
    const actual = await resolveExistingWorkspacePath(context.workspace, path)
    return { content: truncate(await readFile(actual, 'utf8')) }
  },
}

export const listFilesTool: AgentTool = {
  name: 'list_files',
  description: 'List files recursively inside a workspace directory',
  risk: 'read',
  inputSchema: objectSchema({ path: { type: 'string' } }),
  async execute(input, context) {
    const { path = '.' } = z.object({ path: z.string().optional() }).parse(input)
    const root = await resolveExistingWorkspacePath(context.workspace, path)
    const files: string[] = []
    await walk(root, context.workspace, files)
    return { content: truncate(files.sort().join('\n')) }
  },
}

export const searchFilesTool: AgentTool = {
  name: 'search_files',
  description: 'Search UTF-8 workspace files for a literal text query',
  risk: 'read',
  inputSchema: objectSchema(
    { query: { type: 'string' }, path: { type: 'string' } },
    ['query'],
  ),
  async execute(input, context) {
    const { query, path = '.' } = z
      .object({ query: z.string().min(1), path: z.string().optional() })
      .parse(input)
    const root = await resolveExistingWorkspacePath(context.workspace, path)
    const files: string[] = []
    await walk(root, context.workspace, files, true)
    const matches: string[] = []
    for (const file of files) {
      const actual = await resolveExistingWorkspacePath(context.workspace, file)
      let content: string
      try {
        content = await readFile(actual, 'utf8')
      } catch {
        continue
      }
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(query)) matches.push(`${file}:${index + 1}: ${line}`)
      })
    }
    return { content: truncate(matches.join('\n') || 'No matches') }
  },
}

export const writeFileTool: AgentTool = {
  name: 'write_file',
  description: 'Create or replace a UTF-8 file inside the workspace',
  risk: 'write',
  inputSchema: objectSchema(
    { path: { type: 'string' }, content: { type: 'string' } },
    ['path', 'content'],
  ),
  async execute(input, context) {
    const { path, content } = z
      .object({ path: z.string(), content: z.string() })
      .parse(input)
    const actual = await resolveWritableWorkspacePath(context.workspace, path)
    await writeFile(actual, content, 'utf8')
    return { content: `Wrote ${content.length} characters to ${path}` }
  },
}

export const shellTool: AgentTool = {
  name: 'shell',
  description: 'Run a shell command inside the workspace',
  risk: 'execute',
  inputSchema: objectSchema({ command: { type: 'string' } }, ['command']),
  async execute(input, context) {
    const { command } = z.object({ command: z.string().min(1) }).parse(input)
    const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const args =
      process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command]
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: context.workspace,
      timeout: 30_000,
      maxBuffer: 1_000_000,
      signal: context.signal,
    })
    return { content: truncate([stdout, stderr].filter(Boolean).join('\n')) }
  },
}

export const builtinActionTools = [
  readFileTool,
  listFilesTool,
  searchFilesTool,
  writeFileTool,
  shellTool,
] as const

async function walk(
  root: string,
  workspace: string,
  output: string[],
  filesOnly = false,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }
    const fullPath = `${root}/${entry.name}`
    const rel = relative(workspace, fullPath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (!filesOnly) output.push(`${rel}/`)
      await walk(fullPath, workspace, output, filesOnly)
    } else if (entry.isFile()) {
      output.push(rel)
    }
  }
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required }
}
