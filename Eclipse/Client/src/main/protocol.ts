// Wire protocol client-side implementation. Must stay byte-for-byte
// compatible with Pulse's Communication/Communication.cpp — the C++
// engine is the source of truth for this format.
//
// This is deliberately much simpler than the old protocol.ts (which
// targeted a different, unrelated backend — Engine/Runtime's named-pipe,
// versioned, CRC32-checksummed framing). Pulse's real TcpServer
// speaks a plain length-prefixed byte stream: no version byte, no message
// type, no checksum.
//
// Request  (client -> engine): uint32 length (big-endian) + raw UTF-8 script bytes.
// Response (engine -> client): uint32 length (big-endian) + raw UTF-8 text.
//   The engine currently only ever replies "OK:queued" (accepted, not yet
//   executed — see Communication.cpp's own comment on why full
//   execution-result feedback isn't wired yet) or "ERR:<reason>".

export const LENGTH_PREFIX_SIZE = 4;
export const MAX_SCRIPT_SIZE = 8 * 1024 * 1024; // matches Communication.cpp's ScriptLen bound

export function buildRequest(script: string): Buffer {
  const payload = Buffer.from(script, "utf-8");
  if (payload.length === 0) {
    throw new Error("Script is empty");
  }
  if (payload.length > MAX_SCRIPT_SIZE) {
    throw new Error(`Script too large: ${payload.length} bytes (max ${MAX_SCRIPT_SIZE})`);
  }

  const buf = Buffer.alloc(LENGTH_PREFIX_SIZE + payload.length);
  buf.writeUInt32BE(payload.length, 0); // big-endian — matches Communication.cpp's ntohl()
  payload.copy(buf, LENGTH_PREFIX_SIZE);
  return buf;
}

export type EngineResponse = {
  ok: boolean;
  text: string;
};

function parseResponseText(text: string): EngineResponse {
  if (text.startsWith("OK")) {
    return { ok: true, text };
  }
  if (text.startsWith("ERR:")) {
    return { ok: false, text: text.slice(4) };
  }
  // Anything else is unexpected, but still a real reply from something —
  // surface it rather than silently treating it as failure or success.
  return { ok: false, text };
}

/**
 * Incrementally accumulates bytes from the TCP stream and extracts the one
 * length-prefixed response the engine sends per connection. The engine
 * closes the socket right after writing its response, so in practice this
 * only ever needs to assemble a single message per connection — but chunk
 * boundaries are still arbitrary, so the accumulation logic can't assume
 * one `data` event equals one full message.
 */
export class ResponseFramer {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): EngineResponse[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;

    const responses: EngineResponse[] = [];

    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_SIZE) break;

      const payloadSize = this.buffer.readUInt32BE(0);
      if (payloadSize > MAX_SCRIPT_SIZE) {
        // Not a length this protocol would ever legitimately send —
        // drop everything buffered rather than trying to resync.
        this.buffer = Buffer.alloc(0);
        break;
      }

      const totalSize = LENGTH_PREFIX_SIZE + payloadSize;
      if (this.buffer.length < totalSize) break; // wait for more data

      const text = this.buffer.subarray(LENGTH_PREFIX_SIZE, totalSize).toString("utf-8");
      responses.push(parseResponseText(text));

      this.buffer = this.buffer.subarray(totalSize);
    }

    return responses;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
