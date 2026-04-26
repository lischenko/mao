import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { WorkflowConfig } from "../types.js";
import { buildProjectStatusSnapshot } from "./read-model.js";

export interface ObservabilityServerOptions {
  project: string;
  repo: string;
  workflow: WorkflowConfig;
  db: Db;
  host?: string;
  port: number;
}

export interface ObservabilityServer {
  server: Server;
  url: string;
}

export async function startObservabilityServer(opts: ObservabilityServerOptions): Promise<ObservabilityServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => handleRequest(req, res, opts));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    url: `http://${host}:${opts.port}`,
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse, opts: ObservabilityServerOptions): void {
  if (!req.url) {
    sendJson(res, 400, { error: "missing request URL" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    sendOptions(res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/api") {
    sendJson(res, 200, {
      name: "mao observability",
      project: opts.project,
      endpoints: ["/api/health", "/api/status"],
    });
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, project: opts.project });
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, 200, buildProjectStatusSnapshot({
      project: opts.project,
      repo: opts.repo,
      workflow: opts.workflow,
      db: opts.db,
    }));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendOptions(res: ServerResponse): void {
  setCorsHeaders(res);
  res.writeHead(204, {
    "Allow": "GET, OPTIONS",
  });
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  setCorsHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
