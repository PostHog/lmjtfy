/** Minimal server-sent-events writer for the ask stream. */
export class EventStream {
  readonly readable: ReadableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #encoder = new TextEncoder();
  #closed = false;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.#closed = true;
      },
    });
  }

  send(event: string, data: unknown): void {
    if (this.#closed) return;
    try {
      this.#controller.enqueue(
        this.#encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      this.#closed = true;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#controller.close();
    } catch {
      /* already torn down by the client */
    }
  }

  response(): Response {
    return new Response(this.readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
}
