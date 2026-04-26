import type { AgentId } from "./types.js";
import type { Db } from "./db.js";

export interface DeadlockCycle {
  agents: AgentId[];
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

export function formatDeadlockError(cycle: DeadlockCycle): string {
  const chain = cycle.agents.join(" -> ") + " -> " + cycle.agents[0];
  return (
    `Deadlock detected.\n\n` +
    `A circular wait was detected: ${chain}\n\n` +
    `All agents in the cycle are waiting on each other with no ready work. ` +
    `Reset the project or inspect the wait graph with mao status.`
  );
}
