export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly step: string,
    public readonly executionId: string,
    public readonly storyId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}