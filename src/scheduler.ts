import type { Db } from "./db.js";
import type { WorkflowConfig, AgentRecord } from "./types.js";
import { getPersona } from "./workflow.js";
import { detectDeadlocks, formatDeadlockError } from "./graph.js";
import { markInboxDelivered, readInbox } from "./mailbox.js";
import { runAgentTurn } from "./runner.js";
import { defaultHumanRecipient, HUMAN_AGENT_ID, runHumanTurn, routeHumanTurn } from "./human.js";

const DEFAULT_MAX_PARALLEL = 8;

export interface SchedulerOptions {
  projectDir: string;
  repoDir: string;
  workflow: WorkflowConfig;
  db: Db;
  modelOverride?: string;
  maxParallel?: number;
  onTurnStart?: (agentId: string) => void;
  onTurnEnd?: (agentId: string, response: string) => void;
}

/**
 * Run the scheduler loop until all agents are idle.
 * When maxParallel > 1, up to that many non-human agents run their turns
 * concurrently (each in its own session file, safe for SQLite WAL).
 *
 * The loop is safe to interrupt (SIGINT) and resume via `mao run` since all state
 * is persisted to SQLite after every turn.
 */
export async function runScheduler(opts: SchedulerOptions): Promise<void> {
  const { db } = opts;
  const maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;

  while (true) {
    refreshAgentStatuses(db);
    const readyAgents = db.getReadyAgents();

    if (readyAgents.length === 0) {
      const waitingAgents = db.getAllAgents().filter((a) => a.status === "waiting");
      if (waitingAgents.length > 0) {
        const cycles = detectDeadlocks(db);
        if (cycles.length > 0) {
          throw new Error(cycles.map(formatDeadlockError).join("\n\n"));
        }
        throw new Error(formatStalledWaitGraph(db));
      }
      break;
    }

    // Fair scheduling: oldest-ready-first, but run up to maxParallel at once.
    // If maxParallel is 1 or the human agent is the next ready agent, run singly.
    const batch = selectBatch(readyAgents, maxParallel);

    await Promise.all(batch.map((agent) => runOneTurn(agent, opts)));
  }
}

/** Pick the next batch of agents to run. Human always runs alone. */
function selectBatch(readyAgents: AgentRecord[], maxParallel: number): AgentRecord[] {
  if (maxParallel <= 1) return [readyAgents[0]];
  const batch: AgentRecord[] = [];
  for (const agent of readyAgents) {
    if (agent.id === HUMAN_AGENT_ID) {
      // Human always gets a solo turn to avoid stdin chaos.
      if (batch.length === 0) return [agent];
      break;
    }
    batch.push(agent);
    if (batch.length >= maxParallel) break;
  }
  return batch;
}

async function runOneTurn(
  agent: AgentRecord,
  opts: SchedulerOptions
): Promise<void> {
  const { db, workflow, projectDir, repoDir, onTurnStart, onTurnEnd } = opts;

  onTurnStart?.(agent.id);
  db.setAgentStatus(agent.id, "running");

  const turnId = db.startTurn(agent.id);

  try {
    const { inboxText, messages } = readInbox(db, agent.id, workflow);
    db.recordTurnInbox(turnId, messages.map((message) => message.id));

    let response: string;

    if (agent.id === HUMAN_AGENT_ID) {
      const defaultRecipient = defaultHumanRecipient(messages, workflow.lead);
      const result = await runHumanTurn(db, inboxText, defaultRecipient);
      response = routeHumanTurn(db, result, turnId);
      setStatusAfterTurn(db, agent.id);
    } else {
      const persona = getPersona(workflow, agent.personaId);
      if (!persona) {
        throw new Error(`No persona found for agent ${agent.id} (persona: ${agent.personaId})`);
      }

      response = await runAgentTurn(db, projectDir, repoDir, agent.id, persona, workflow, inboxText, turnId, opts.modelOverride);

      setStatusAfterTurn(db, agent.id);
    }

    db.endTurn(turnId, "completed");
    markInboxDelivered(db, messages);

    onTurnEnd?.(agent.id, response);
  } catch (err) {
    db.endTurn(turnId, "failed");
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`[mao] Turn failed for ${agent.id}:`, errMessage);

    // Auto-reply to waiting agents and set this agent to error state.
    // No retries — model errors (rate limits, auth, etc.) won't fix themselves.
    db.failOpenMailFor(agent.id, errMessage, turnId);
    db.setAgentStatus(agent.id, "error");
    process.stdout.write(`\n  [mao] ${agent.id}: turn failed — status: error. ${errMessage}\n`);
  }
}

function setStatusAfterTurn(db: Db, agentId: string): void {
  if (db.getWaitEdges(agentId).length > 0) {
    db.setAgentStatus(agentId, "waiting");
  } else if (db.hasUndeliveredMessages(agentId)) {
    db.setAgentStatus(agentId, "ready", Date.now());
  } else if (db.getOpenMailTo(agentId)) {
    db.setAgentStatus(agentId, "ready", Date.now());
  } else {
    db.setAgentStatus(agentId, "idle");
  }
}

function refreshAgentStatuses(db: Db): void {
  for (const agent of db.getAllAgents()) {
    // Never touch agents in error or running state.
    if (agent.status === "running" || agent.status === "error") continue;

    if (db.getWaitEdges(agent.id).length > 0) {
      if (agent.status !== "waiting") db.setAgentStatus(agent.id, "waiting");
    } else if (db.hasUndeliveredMessages(agent.id) || db.getOpenMailTo(agent.id)) {
      if (agent.status !== "ready") db.setAgentStatus(agent.id, "ready", Date.now());
    } else if (agent.status !== "idle") {
      db.setAgentStatus(agent.id, "idle");
    }
  }
}

function formatStalledWaitGraph(db: Db): string {
  const edges = db.getAllWaitEdges();
  const graph = edges.map((edge) => `${edge.agentId} -> ${edge.waitingFor}`).join(", ");
  return `Scheduler stalled with waiting agents but no ready work. Wait graph: ${graph || "(empty)"}`;
}
