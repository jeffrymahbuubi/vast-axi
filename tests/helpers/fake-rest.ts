import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request the fake REST server received. */
export interface RestRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Raw body text. */
  raw: string;
  /** Parsed JSON body (undefined when the body is not JSON). */
  body: unknown;
}

export interface RestReply {
  status?: number;
  /** Object bodies are sent as JSON, strings as is. */
  body?: unknown;
  /** Answer only after this many ms (timeout tests). */
  delayMs?: number;
  /** Never answer (the client must time out). */
  hang?: boolean;
  /** Extra response headers, for example a redirect's Location. */
  headers?: Record<string, string>;
}

export type RestHandler = (req: RestRequest) => RestReply;

export interface FakeRest {
  /** Base URL for VAST_AXI_API_URL, for example http://127.0.0.1:41234 */
  url: string;
  requests: RestRequest[];
  close: () => Promise<void>;
}

/** The success answer the live API gives for POST /api/v0/commands/schedule_job/. */
export const scheduleOk = (id = 5081): RestReply => ({
  status: 200,
  body: { success: true, scheduled_job_id: id, msg: "scheduled" },
});

/**
 * A local stand-in for console.vast.ai (no network). Every request is recorded;
 * `handler` decides the answer (default: the success answer with job id 5081).
 */
export async function startFakeRest(
  handler: RestHandler = () => scheduleOk(),
): Promise<FakeRest> {
  const requests: RestRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const request: RestRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        raw,
        body,
      };
      requests.push(request);
      const reply = handler(request);
      if (reply.hang) return;
      const send = () => {
        const text =
          typeof reply.body === "string"
            ? reply.body
            : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, {
          "Content-Type": "application/json",
          ...reply.headers,
        });
        res.end(text);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
