import type { TranscriptEvent } from '../types.ts'

export class Transcript {
  readonly events: TranscriptEvent[] = []

  record(type: TranscriptEvent['type'], data: unknown): void {
    this.events.push({ timestamp: new Date().toISOString(), type, data })
  }
}
