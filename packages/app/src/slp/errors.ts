/** The host answered an SLP group request with a named refusal instead of a result. */
export class SlpGroupRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlpGroupRefusedError";
  }
}
