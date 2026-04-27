import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, TurnStats } from "../db.js";
import type { AgentStatus, WorkflowConfig } from "../types.js";
import { getPersona } from "../workflow.js";

export interface ProjectStatusSnapshot {
  version: 1;
  generatedAt: number;
  project: string;
  repo: string;
  workflow: {
    id: string;
    name: string;
  };
  agents: AgentStatusView[];
  waitEdges: WaitEdgeView[];
  communicationEdges: CommunicationEdgeView[];
  totals: StatusTotals;
}

export interface AgentStatusView {
  id: string;
  personaId: string;
  name?: string;
  role?: string;
  status: AgentStatus;
  inbox: number;
  turns: TurnStats;
  activity: AgentActivityView;
  waitingOn: string[];
  waitedOnBy: string[];
}

export interface AgentActivityView {
  sessionEvents: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  thinkingBlocks: number;
  textBlocks: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  lastAt: number | null;
  lastKind: string | null;
  lastLabel: string | null;
}

export interface WaitEdgeView {
  mailId: string;
  from: string;
  to: string;
  createdAt: number;
}

export interface CommunicationEdgeView {
  from: string;
  to: string;
  count: number;
  lastAt: number;
  openCount: number;
}

export interface StatusTotals {
  agents: number;
  idle: number;
  ready: number;
  running: number;
  waiting: number;
  error: number;
  inbox: number;
  openMail: number;
  completedTurns: number;
  failedTurns: number;
  totalTurns: number;
}

export function buildProjectStatusSnapshot(args: {
  project: string;
  projectDir?: string;
  repo: string;
  workflow: WorkflowConfig;
  db: Db;
}): ProjectStatusSnapshot {
  const { project, projectDir, repo, workflow, db } = args;
  const agents = db.getAllAgents();
  const waitEdges = db.getAllWaitEdges().map((edge): WaitEdgeView => ({
    mailId: edge.mailId,
    from: edge.agentId,
    to: edge.waitingFor,
    createdAt: edge.createdAt,
  }));
  const openCountByPair = new Map<string, number>();
  for (const edge of waitEdges) {
    const key = edgeKey(edge.from, edge.to);
    openCountByPair.set(key, (openCountByPair.get(key) ?? 0) + 1);
  }
  const communicationEdges = db.getCommunicationEdges().map((edge): CommunicationEdgeView => ({
    from: edge.from,
    to: edge.to,
    count: edge.count,
    lastAt: edge.lastAt,
    openCount: openCountByPair.get(edgeKey(edge.from, edge.to)) ?? 0,
  }));

  const waitingOn = new Map<string, string[]>();
  const waitedOnBy = new Map<string, string[]>();
  for (const edge of waitEdges) {
    pushMap(waitingOn, edge.from, edge.to);
    pushMap(waitedOnBy, edge.to, edge.from);
  }

  const views = agents.map((agent): AgentStatusView => {
    const persona = getPersona(workflow, agent.personaId);
    return {
      id: agent.id,
      personaId: agent.personaId,
      name: persona?.name,
      role: persona?.role,
      status: agent.status,
      inbox: db.getUndeliveredMessages(agent.id).length,
      turns: db.getTurnStats(agent.id),
      activity: readAgentActivity(projectDir, agent.id),
      waitingOn: waitingOn.get(agent.id) ?? [],
      waitedOnBy: waitedOnBy.get(agent.id) ?? [],
    };
  });

  const totals: StatusTotals = {
    agents: views.length,
    idle: 0,
    ready: 0,
    running: 0,
    waiting: 0,
    error: 0,
    inbox: 0,
    openMail: waitEdges.length,
    completedTurns: 0,
    failedTurns: 0,
    totalTurns: 0,
  };

  for (const agent of views) {
    totals[agent.status]++;
    totals.inbox += agent.inbox;
    totals.completedTurns += agent.turns.completed;
    totals.failedTurns += agent.turns.failed;
    totals.totalTurns += agent.turns.total;
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    project,
    repo,
    workflow: {
      id: workflow.id,
      name: workflow.name,
    },
    agents: views,
    waitEdges,
    communicationEdges,
    totals,
  };
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function readAgentActivity(projectDir: string | undefined, agentId: string): AgentActivityView {
  const activity: AgentActivityView = {
    sessionEvents: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    thinkingBlocks: 0,
    textBlocks: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    lastAt: null,
    lastKind: null,
    lastLabel: null,
  };
  if (!projectDir) return activity;

  const sessionFile = join(projectDir, "sessions", `${agentId}.jsonl`);
  if (!existsSync(sessionFile)) return activity;

  const lines = readFileSync(sessionFile, "utf-8").split(/\n/).filter(Boolean);
  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    activity.sessionEvents++;
    const at = parseTimestamp(event.timestamp);
    if (at !== null && (activity.lastAt === null || at >= activity.lastAt)) {
      activity.lastAt = at;
      activity.lastKind = event.type ?? null;
      activity.lastLabel = formatSessionEventLabel(event);
    }

    if (event.type !== "message") continue;
    const message = event.message;
    if (!message) continue;
    if (message.role === "user") activity.userMessages++;
    else if (message.role === "assistant") activity.assistantMessages++;
    else if (message.role === "toolResult") activity.toolResults++;

    const usage = message.usage;
    if (usage) {
      activity.inputTokens += numberValue(usage.input);
      activity.outputTokens += numberValue(usage.output);
      activity.totalTokens += numberValue(usage.totalTokens);
      activity.totalCost += numberValue(usage.cost?.total);
    }

    for (const item of message.content ?? []) {
      if (item?.type === "thinking") activity.thinkingBlocks++;
      else if (item?.type === "text") activity.textBlocks++;
      else if (item?.type === "toolCall") activity.toolCalls++;
    }
  }

  return activity;
}

function formatSessionEventLabel(event: any): string | null {
  if (event.type !== "message") return event.type ?? null;
  const message = event.message;
  if (!message) return "message";
  if (message.role === "toolResult") return `tool result: ${event.message.toolName ?? "tool"}`;
  if (message.role === "user") return "turn prompt";
  if (message.role !== "assistant") return message.role ?? "message";

  const content = message.content ?? [];
  const last = content[content.length - 1];
  if (last?.type === "toolCall") return `tool: ${last.name ?? "tool"}`;
  if (last?.type === "thinking") return "thinking";
  if (last?.type === "text") return "assistant text";
  return "assistant";
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
