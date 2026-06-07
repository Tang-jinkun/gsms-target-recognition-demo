import chokidar, { type FSWatcher } from 'chokidar'
import { SkillLoader } from './SkillLoader.ts'
import { SkillRegistry } from './SkillRegistry.ts'
import type { SkillDiagnostic } from './types.ts'

export interface SkillWatcherOptions {
  debounceMs?: number
  onDiagnostics?: (diagnostics: readonly SkillDiagnostic[]) => void
}

export class SkillWatcher {
  readonly #debounceMs: number
  readonly #onDiagnostics?: (diagnostics: readonly SkillDiagnostic[]) => void
  #watcher?: FSWatcher
  #timer?: ReturnType<typeof setTimeout>

  constructor(
    readonly loader: SkillLoader,
    readonly registry: SkillRegistry,
    options: SkillWatcherOptions = {},
  ) {
    this.#debounceMs = options.debounceMs ?? 300
    this.#onDiagnostics = options.onDiagnostics
  }

  async reloadNow(options: { acceptPartial?: boolean } = {}): Promise<boolean> {
    const result = await this.loader.load()
    this.#onDiagnostics?.(result.diagnostics)
    const hasErrors = result.diagnostics.some(item => item.severity === 'error')
    if (hasErrors && !options.acceptPartial) return false
    this.registry.replace(result.skills)
    return true
  }

  async start(): Promise<void> {
    if (this.#watcher) return
    await this.reloadNow({ acceptPartial: true })
    this.#watcher = chokidar.watch(this.loader.watchPaths, {
      ignoreInitial: true,
      depth: 2,
    })
    this.#watcher.on('all', () => this.#scheduleReload())
  }

  async close(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    await this.#watcher?.close()
    this.#watcher = undefined
  }

  #scheduleReload(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.reloadNow()
    }, this.#debounceMs)
  }
}
