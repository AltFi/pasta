// HTTP bridge (127.0.0.1:6970) — the injected DLL's http.request/HttpGet
// implementation never touches the network itself. Loading WINHTTP.dll (or
// any other non-Roblox DLL) into RobloxPlayerBeta.exe trips Hyperion's
// module checks at injection time, so HTTP is performed HERE, in the Electron
// main process, using Node's built-in http/https (OpenSSL inside the client
// process, not inside Roblox). The DLL (Pulse/.../Libraries/Http.hpp) sends a
// framed JSON request over a TCP connection, blocks a Yielding worker thread
// for the response, then resumes the Lua coroutine.
//
// Wire format (mirrors Communication.cpp / protocol.ts framing):
//   DLL -> bridge: uint32 length (big-endian) + JSON
//     { "method": "GET", "url": "...", "headers": {...}, "bodyBase64": "..." }
//   bridge -> DLL: uint32 length (big-endian) + JSON
//     success: { "ok": true, "statusCode": 200, "headers": {...}, "cookies": {...}, "bodyBase64": "..." }
//     error:   { "ok": false, "error": "..." }
// Bodies travel as base64 because HTTP payloads are arbitrary bytes, not
// safely transportable as plain JSON strings.

import { createServer, Server, Socket } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 6970; // must match Http.hpp's BridgePort
const MAX_FRAME = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_REDIRECTS = 50; // matches the old WinHTTP redirect policy (ALWAYS, 50 max)
const SOCKET_TIMEOUT_MS = 30000;

const VALID_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

type BridgeRequest = {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
};

type SuccessOutcome = { ok: true; status: number; rawHeaders: string[]; body: Buffer };
type FailedOutcome = { ok: false; error: string };
type HttpOutcome = SuccessOutcome | FailedOutcome;

function performOnce(entryUrl: string, method: string, headers: http.OutgoingHttpHeaders, body: Buffer | undefined): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(entryUrl);
    } catch {
      resolve({ ok: false, error: `Invalid URL: ${entryUrl}` });
      return;
    }

    const module = target.protocol === "https:" ? https : http;
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      resolve({ ok: false, error: `Unsupported protocol: ${target.protocol}` });
      return;
    }

    const request = module.request(target, { method, headers, timeout: SOCKET_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ ok: true, status: res.statusCode ?? 0, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", (err) => resolve({ ok: false, error: err.message }));
    });

    request.on("timeout", () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", (err) => resolve({ ok: false, error: err.message }));
    if (body && body.length > 0) request.write(body);
    request.end();
  });
}

function rawHeaderValue(rawHeaders: string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === lower) return rawHeaders[i + 1];
  }
  return undefined;
}

function removeHeader(headers: http.OutgoingHttpHeaders, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function buildResult(outcome: SuccessOutcome): Record<string, unknown> {
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  for (let i = 0; i + 1 < outcome.rawHeaders.length; i += 2) {
    const name = outcome.rawHeaders[i];
    const value = outcome.rawHeaders[i + 1];
    // Set-Cookie handling matches the old client-side parser: take the
    // first "name=value" segment, ignore attributes after the first ';'.
    if (name.toLowerCase() === "set-cookie") {
      const first = value.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) {
        const key = first.slice(0, eq).trim();
        const cookieValue = first.slice(eq + 1).trim();
        if (key) cookies[key] = cookieValue;
      }
    }
    // Mirror WinHTTP's raw-header parsing: same-named headers last-one-wins.
    headers[name] = value;
  }
  return { ok: true, statusCode: outcome.status, headers, cookies, bodyBase64: outcome.body.toString("base64") };
}

async function executeBridgeRequest(bridgeReq: BridgeRequest): Promise<Record<string, unknown>> {
  const rawMethod = typeof bridgeReq.method === "string" ? bridgeReq.method.toUpperCase() : "GET";
  const method = VALID_METHODS.has(rawMethod) ? rawMethod : "GET";
  const url = typeof bridgeReq.url === "string" ? bridgeReq.url : "";
  if (url === "") return { ok: false, error: "Missing 'url'" };

  const headers: http.OutgoingHttpHeaders = {};
  if (bridgeReq.headers && typeof bridgeReq.headers === "object") {
    for (const [key, value] of Object.entries(bridgeReq.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
  }

  let body = Buffer.alloc(0);
  if (typeof bridgeReq.bodyBase64 === "string" && bridgeReq.bodyBase64.length > 0) {
    try {
      body = Buffer.from(bridgeReq.bodyBase64, "base64");
    } catch {
      body = Buffer.alloc(0);
    }
  }

  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const outcome = await performOnce(currentUrl, currentMethod, headers, currentBody.length > 0 ? currentBody : undefined);
    if (!outcome.ok) return { ok: false, error: outcome.error };

    const location = rawHeaderValue(outcome.rawHeaders, "location");
    const isRedirect = REDIRECT_STATUS.has(outcome.status);
    if (!isRedirect || !location) return buildResult(outcome);
    if (redirects === MAX_REDIRECTS) return { ok: false, error: "Too many redirects" };

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      return { ok: false, error: "Invalid redirect Location" };
    }

    // 301/302 demote non-GET/HEAD to GET, 303 always goes to GET,
    // 307/308 preserve the method (standard redirect semantics).
    const nextMethod =
      outcome.status === 303 || (REDIRECT_STATUS.has(outcome.status) && outcome.status !== 307 && outcome.status !== 308 && currentMethod !== "GET" && currentMethod !== "HEAD")
        ? "GET"
        : currentMethod;

    let nextBody = currentBody;
    if (nextMethod !== currentMethod) {
      nextBody = Buffer.alloc(0);
      removeHeader(headers, "content-length");
      removeHeader(headers, "content-type");
    }

    currentUrl = nextUrl;
    currentMethod = nextMethod;
    currentBody = nextBody;
  }

  return { ok: false, error: "Too many redirects" };
}

function sendResponse(socket: Socket, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  if (!socket.destroyed) socket.end(frame);
}

function handleConnection(socket: Socket): void {
  let buffer: Buffer = Buffer.alloc(0);

  const processBuffer = (): void => {
    if (buffer.length < 4) return;
    const payloadLength = buffer.readUInt32BE(0);
    if (payloadLength === 0 || payloadLength > MAX_FRAME) {
      socket.destroy();
      return;
    }
    if (buffer.length < 4 + payloadLength) return;

    const payload = buffer.subarray(4, 4 + payloadLength).toString("utf-8");
    buffer = buffer.subarray(4 + payloadLength);

    let request: BridgeRequest;
    try {
      request = JSON.parse(payload);
    } catch {
      sendResponse(socket, { ok: false, error: "Invalid JSON request" });
      return;
    }

    void executeBridgeRequest(request)
      .then((result) => sendResponse(socket, result))
      .catch((err) => sendResponse(socket, { ok: false, error: err instanceof Error ? err.message : String(err) }));
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    processBuffer();
  });
  socket.on("error", () => socket.destroy());
}

let server: Server | null = null;

export function startHttpBridge(): void {
  if (server) return;
  server = createServer(handleConnection);
  server.on("error", (err) => {
    // The bridge is best-effort: if the port is already taken, http.request
    // inside the engine will simply fail with a clear error. Log and clear.
    console.error(`HTTP bridge failed: ${err.message}`);
    server = null;
  });
  server.listen(BRIDGE_PORT, BRIDGE_HOST);
}

export function stopHttpBridge(): void {
  if (!server) return;
  server.close();
  server = null;
}