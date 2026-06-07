import type { AgentTool, ModelToolDefinition } from '../types.ts'

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>()

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: AgentTool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.#tools.set(tool.name, tool)
  }

  resolve(name: string): AgentTool | undefined {
    return this.#tools.get(name)
  }

  list(): AgentTool[] {
    return [...this.#tools.values()]
  }

  definitions(): ModelToolDefinition[] {
    return this.list().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }
}
