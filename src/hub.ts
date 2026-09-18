/**
 * A single Durable Object that fans new readings out to everyone with the page
 * open, so the ledger is genuinely live rather than polled.
 *
 * Every connected visitor holds one SSE stream against this object, so it is a
 * deliberate hotspot. Subscribers are capped and the page falls back to polling
 * when the cap is hit or the stream drops, which keeps a traffic spike from
 * turning a nice-to-have into an outage.
 */

const MAX_SUBSCRIBERS = 4000;
const HEARTBEAT_MS = 25_000;

export class ReadingsHub {
  #state: DurableObjectState;
  #writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  #encoder = new TextEncoder();

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/subscribe") return this.#subscribe();
    if (pathname === "/publish") {
      const body = await request.text();
      this.#broadcast("reading", body);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  #subscribe(): Response {
    if (this.#writers.size >= MAX_SUBSCRIBERS) {
      // Tell the page to stop trying and poll instead.
      return new Response("at capacity", { status: 503 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.#writers.add(writer);

    // An initial comment flushes headers so the browser fires `onopen`.
    writer.write(this.#encoder.encode(": connected\n\n")).catch(() => this.#drop(writer));
    void this.#state.storage.setAlarm(Date.now() + HEARTBEAT_MS);

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Keeps idle connections from being reaped by intermediaries. */
  async alarm(): Promise<void> {
    this.#broadcast(null, ": ping");
    if (this.#writers.size > 0) {
      await this.#state.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }
  }

  #broadcast(event: string | null, data: string): void {
    const frame = this.#encoder.encode(
      event === null ? `${data}\n\n` : `event: ${event}\ndata: ${data}\n\n`,
    );
    for (const writer of this.#writers) {
      writer.write(frame).catch(() => this.#drop(writer));
    }
  }

  #drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.#writers.delete(writer);
    writer.close().catch(() => {
      /* already gone */
    });
  }
}
