import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db.js";
import type { WorkflowConfig } from "../types.js";
import { buildProjectStatusSnapshot, buildTurnTimeline, readAgentSession } from "./read-model.js";

export interface ObservabilityServerOptions {
  project: string;
  repo: string;
  projectDir?: string;
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

  if (url.pathname === "/") {
    sendStatic(res, "index.html", "text/html; charset=utf-8");
    return;
  }

  if (/^\/[\w.-]+\.js$/.test(url.pathname)) {
    sendStatic(res, url.pathname.slice(1), "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/style.css") {
    sendStatic(res, "style.css", "text/css; charset=utf-8");
    return;
  }

  if (url.pathname === "/api") {
    sendJson(res, 200, {
      name: "mao observability",
      project: opts.project,
      endpoints: ["/api/health", "/api/status", "/api/agents/:id/session"],
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
      projectDir: opts.projectDir,
      repo: opts.repo,
      workflow: opts.workflow,
      db: opts.db,
    }));
    return;
  }

  if (url.pathname === "/api/turns") {
    sendJson(res, 200, buildTurnTimeline({
      projectDir: opts.projectDir,
      workflow: opts.workflow,
      db: opts.db,
    }));
    return;
  }

  const sessionMatch = /^\/api\/agents\/([^/]+)\/session$/.exec(url.pathname);
  if (sessionMatch) {
    const agentId = sessionMatch[1];
    if (!/^[\w-]+$/.test(agentId)) {
      sendJson(res, 400, { error: "invalid agent id" });
      return;
    }
    const after = parseIntParam(url.searchParams.get("after"));
    const limit = parseIntParam(url.searchParams.get("limit"));
    sendJson(res, 200, readAgentSession(opts.projectDir, agentId, {
      after: after ?? undefined,
      ...(limit !== null && { limit }),
    }));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function parseIntParam(value: string | null): number | null {
  if (value === null) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
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

function sendStatic(res: ServerResponse, fileName: string, contentType: string): void {
  const path = resolveStaticFile(fileName);
  if (!path) {
    sendJson(res, 500, { error: `static asset not found: ${fileName}` });
    return;
  }

  const body = readFileSync(path);
  setCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function resolveStaticFile(fileName: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "static", fileName),
    join(process.cwd(), "src", "observability", "static", fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
