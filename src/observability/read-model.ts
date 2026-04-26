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
  waitingOn: string[];
  waitedOnBy: string[];
}

export interface WaitEdgeView {
  mailId: string;
  from: string;
  to: string;
  createdAt: number;
}

export interface StatusTotals {
  agents: number;
  idle: number;
  ready: number;
  running: number;
  waiting: number;
  inbox: number;
  openMail: number;
  completedTurns: number;
  failedTurns: number;
  totalTurns: number;
}

export function buildProjectStatusSnapshot(args: {
  project: string;
  repo: string;
  workflow: WorkflowConfig;
  db: Db;
}): ProjectStatusSnapshot {
  const { project, repo, workflow, db } = args;
  const agents = db.getAllAgents();
  const waitEdges = db.getAllWaitEdges().map((edge): WaitEdgeView => ({
    mailId: edge.mailId,
    from: edge.agentId,
    to: edge.waitingFor,
    createdAt: edge.createdAt,
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
    totals,
  };
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
