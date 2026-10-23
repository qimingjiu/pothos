/** A single engine writer includes timers and HTTP/MCP callbacks, not just processes. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}

export class InputError extends Error {
  constructor(message: string, public readonly status: 400 | 409 = 400) { super(message); }
}
