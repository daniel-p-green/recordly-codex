export class SealedSessionRenderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SealedSessionRenderError";
  }
}
