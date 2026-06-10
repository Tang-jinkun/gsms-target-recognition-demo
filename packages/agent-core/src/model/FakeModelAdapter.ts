import type { ModelAdapter, ModelRequest, ModelResponse, StreamChunk } from '../types.ts'

export class FakeModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  #responses: ModelResponse[]

  constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const response = this.#responses.shift()
    if (!response) throw new Error('FakeModelAdapter has no response left')
    return response
  }

  async *completeStreaming(request: ModelRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.#responses.shift()
    if (!response) throw new Error('FakeModelAdapter has no response left')

    for (const tc of response.toolCalls ?? []) {
      yield { type: 'tool_call_start', id: tc.id, name: tc.name }
      // Real providers fragment a tool call's arguments across several deltas.
      // Split into chunks so the reassembly logic is exercised, not bypassed.
      const json = JSON.stringify(tc.input)
      for (let i = 0; i < json.length; i += 7) {
        yield { type: 'tool_call_delta', id: tc.id, argumentsDelta: json.slice(i, i + 7) }
      }
    }
    yield { type: 'done' }
  }
}
