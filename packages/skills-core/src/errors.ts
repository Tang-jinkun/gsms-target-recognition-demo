export class SkillError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNKNOWN_SKILL'
      | 'NOT_INVOCABLE'
      | 'AUTHORIZATION_DENIED'
      | 'RECURSIVE_INVOCATION'
      | 'ISOLATED_RUNNER_REQUIRED',
  ) {
    super(message)
    this.name = 'SkillError'
  }
}
