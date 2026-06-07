import type { ModelAdapter, ModelRequest, ModelResponse } from '../types.ts'

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
}
