// Client for Pulse's TCP protocol (Communication.cpp: 127.0.0.1:6969).
//
// Replaces the old pipeClient.ts, which spoke to a completely different
// backend (Engine/Runtime's named pipe, `\\.\pipe\PulseExecutor`, a
// persistent stateful connection multiplexing Script/Command/Heartbeat
// message types through one socket). That backend isn't what actually
// runs — Pulse is the real engine, and its TcpServer is stateless
// per connection: accept, read one script, write one response, close. There
// is no persistent session to hold open, and no wire-level concept of a
// "command" or "heartbeat" distinct from "here is a script to run."
//
// Because of that, this client does NOT keep a socket open between calls —
// every send() is its own connect -> write -> read-response -> close cycle.
// "Connected" as a persistent state doesn't map onto this protocol; what's
// tracked instead is "last known reachability," updated by the outcome of
// the most recent request.

import { connect as netConnect, Socket } from "node:net";
import { EventEmitter } from "node:events";
import { buildRequest, ResponseFramer, EngineResponse } from "./protocol";
import type { ConnectionState, PipeStatus } from "../shared/ipc";

const ENGINE_HOST = "127.0.0.1";
const ENGINE_PORT = 6969;
const CONNECT_TIMEOUT_MS = 4000;
// Bootstrap() in the injected DLL runs its own DataModel poll before
// Communication::Initialize() ever opens the listening socket, so a single
// connect attempt right after injection almost always arrives before the
// socket exists (ECONNREFUSED). Keep retrying until the engine catches up.
const CONNECT_RETRY_TOTAL_MS = 20000;
const CONNECT_RETRY_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 8000;

// A harmless, real script — a Luau comment — used to verify the engine is
// actually alive and accepting requests. Deliberately NOT a fake
// "heartbeat" message type (the wire protocol has no such concept); this
// exercises the exact same code path a real script send does, so a
// successful reply is a genuine end-to-end confirmation, not a simulated one.
const PING_SCRIPT = "-- PulseExecutor connectivity check";

export class RuntimeClient extends EventEmitter {
  private state: ConnectionState = "disconnected";
  private messagesSent = 0;
  private messagesReceived = 0;
  private lastError: string | undefined;

  getStatus(): PipeStatus {
    return {
      state: this.state,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      lastError: this.lastError,
    };
  }

  /** Verifies the engine is reachable by sending PING_SCRIPT and waiting for a real reply. */
  async connect(): Promise<PipeStatus> {
    this.setState("connecting");

    const deadline = Date.now() + CONNECT_RETRY_TOTAL_MS;

    for (;;) {
      try {
        const response = await this.sendOnce(PING_SCRIPT, CONNECT_TIMEOUT_MS);
        if (!response.ok) {
          throw new Error(response.text || "Engine rejected the connectivity check");
        }
        this.lastError = undefined;
        this.setState("connected");
        return this.getStatus();
      } catch (err) {
        const code = errorCode(err);
        const isEngineNotUpYet = code === "ECONNREFUSED" || code === "ENOENT";
        if (!isEngineNotUpYet || Date.now() >= deadline) {
          const userMessage = this.describeConnectError(err instanceof Error ? err.message : String(err), code);
          this.lastError = userMessage;
          this.setState("error");
          throw new Error(userMessage);
        }
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }
  }

  private describeConnectError(rawMessage: string, code?: string): string {
    if (code === "ECONNREFUSED") {
      return "Engine not responding on 127.0.0.1:6969. Try injecting again.";
    }
    if (code === "ETIMEDOUT") {
      return "Timed out waiting for the engine to respond.";
    }
    return rawMessage;
  }

  disconnect(): PipeStatus {
    // Nothing to tear down — every request already opens and closes its own
    // socket. This just resets the reachability state shown in the UI.
    this.setState("disconnected");
    return this.getStatus();
  }

  async sendScript(code: string): Promise<EngineResponse> {
    if (code.length === 0) throw new Error("Script is empty");
    if (code.includes("\0")) throw new Error("Script contains invalid null bytes");

    const response = await this.sendOnce(code, REQUEST_TIMEOUT_MS);
    this.setState(response.ok ? "connected" : "error");
    if (!response.ok) this.lastError = response.text;
    return response;
  }

  // Single connect -> write -> read-one-response -> close cycle.
  private sendOnce(script: string, timeoutMs: number): Promise<EngineResponse> {
    return new Promise((resolve, reject) => {
      const request = buildRequest(script);
      const framer = new ResponseFramer();
      let settled = false;

      const socket: Socket = netConnect({ host: ENGINE_HOST, port: ENGINE_PORT });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })));
      }, timeoutMs);

      socket.once("connect", () => {
        socket.write(request, (err) => {
          if (err) finish(() => reject(err));
        });
      });

      socket.on("data", (chunk: Buffer) => {
        let responses: EngineResponse[];
        try {
          responses = framer.push(chunk);
        } catch {
          return;
        }
        if (responses.length > 0) {
          this.messagesSent++;
          this.messagesReceived++;
          finish(() => resolve(responses[0]));
        }
      });

      socket.once("error", (err: Error & { code?: string }) => {
        finish(() => reject(Object.assign(new Error(err.code ?? err.message), { code: err.code })));
      });

      socket.once("close", () => {
        // The engine closes the connection right after writing its
        // response, so a close before any response arrived is a real
        // failure, not just cleanup — but if finish() already ran (the
        // normal case), this is a no-op.
        finish(() => reject(new Error("Connection closed before a response arrived")));
      });
    });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("status", this.getStatus());
  }
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}
