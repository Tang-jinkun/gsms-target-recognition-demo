import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export async function resolveExistingWorkspacePath(
  workspace: string,
  inputPath: string,
): Promise<string> {
  const root = await realpath(workspace)
  const candidate = resolveInput(root, inputPath)
  const actual = await realpath(candidate)
  assertInside(root, actual)
  const stat = await lstat(candidate)
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed')
  return actual
}

export async function resolveWritableWorkspacePath(
  workspace: string,
  inputPath: string,
): Promise<string> {
  const root = await realpath(workspace)
  const candidate = resolveInput(root, inputPath)
  assertInside(root, candidate)
  const parent = await realpath(dirname(candidate))
  assertInside(root, parent)
  try {
    const stat = await lstat(candidate)
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return candidate
}

function resolveInput(root: string, inputPath: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  ) {
    return
  }
  throw new Error(`Path escapes workspace: ${candidate}`)
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
