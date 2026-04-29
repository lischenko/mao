import type { AgentId } from "./types.js";
import type { Db } from "./db.js";

export interface DeadlockCycle {
  agents: AgentId[];
}

export interface ProspectiveCycle {
  chain: AgentId[];
}

/**
 * Detect deadlocks: cycles in the waiting graph where no agent has progress.
 * A cycle is only a deadlock if every agent in it is waiting (not just paused).
 */
export function detectDeadlocks(db: Db): DeadlockCycle[] {
  const edges = db.getAllWaitEdges();
  if (edges.length === 0) return [];

  // Build adjacency: agent -> set of agents it's waiting for
  const adj = new Map<AgentId, Set<AgentId>>();
  for (const edge of edges) {
    if (!adj.has(edge.agentId)) adj.set(edge.agentId, new Set());
    adj.get(edge.agentId)!.add(edge.waitingFor);
  }

  const cycles: DeadlockCycle[] = [];
  const visited = new Set<AgentId>();
  const inStack = new Set<AgentId>();
  const stack: AgentId[] = [];

  function dfs(node: AgentId): void {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        const cycleStart = stack.indexOf(neighbor);
        cycles.push({ agents: stack.slice(cycleStart) });
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node);
  }

  return cycles;
}

export function findProspectiveWaitCycle(db: Db, fromAgent: AgentId, toAgent: AgentId): ProspectiveCycle | null {
  if (fromAgent === toAgent) return { chain: [fromAgent] };

  const edges = db.getAllWaitEdges();
  const adj = new Map<AgentId, AgentId[]>();
  for (const edge of edges) {
    const neighbors = adj.get(edge.agentId) ?? [];
    neighbors.push(edge.waitingFor);
    adj.set(edge.agentId, neighbors);
  }

  const path = findPath(adj, toAgent, fromAgent);
  return path ? { chain: [fromAgent, ...path.slice(0, -1)] } : null;
}

export function formatProspectiveWaitCycleRefusal(cycle: ProspectiveCycle): string {
  return (
    `Refusing to send: this message would create a circular dependency:\n` +
    `${formatCycleChain(cycle.chain)}\n\n` +
    `Reply to an existing pending message in this cycle instead, or wait for one of these dependencies ` +
    `to clear before sending new mail.`
  );
}

export function formatDeadlockError(cycle: DeadlockCycle): string {
  return (
    `Deadlock detected.\n\n` +
    `A circular wait was detected: ${formatCycleChain(cycle.agents)}\n\n` +
    `All agents in the cycle are waiting on each other with no ready work. ` +
    `Reset the project or inspect the wait graph with mao status.`
  );
}

function findPath(adj: Map<AgentId, AgentId[]>, start: AgentId, goal: AgentId): AgentId[] | null {
  const visited = new Set<AgentId>();
  const path: AgentId[] = [];

  function dfs(node: AgentId): boolean {
    visited.add(node);
    path.push(node);

    if (node === goal) return true;

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor) && dfs(neighbor)) return true;
    }

    path.pop();
    return false;
  }

  return dfs(start) ? path : null;
}

function formatCycleChain(agents: AgentId[]): string {
  return agents.join(" -> ") + " -> " + agents[0];
}
