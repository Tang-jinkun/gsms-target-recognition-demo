import type {
  AgentMessage,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from '../types.ts'

export interface OpenAICompatibleOptions {
  apiKey: string
  model: string
  baseUrl?: string
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly #baseUrl: string

  constructor(readonly options: OpenAICompatibleOptions) {
    this.#baseUrl = options.baseUrl ?? 'https://api.openai.com/v1'
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages.map(toOpenAIMessage),
        tools: request.tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: 'auto',
      }),
    })
    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${await response.text()}`)
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
      }>
    }
    const message = json.choices?.[0]?.message
    if (!message) throw new Error('Model response did not contain a message')

    return {
      content: message.content ?? '',
      toolCalls: message.tool_calls?.map(
        (call): ToolCall => ({
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        }),
      ),
    }
  }
}

function toOpenAIMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
