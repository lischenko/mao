// Role: Shared mutable memory. Holds snapshot, open panels, sessions cache.
// Boundary: No DOM, no fetch, no compute—only storage and simple accessors.

export const PANEL_ORIGIN = {
  USER: "user",
  AUTO: "auto",
  SUPPRESSED: "suppressed",
};

export const state = {
  snapshot: null,
  turns: null,
};

export const openPanels = new Map();
export const sessions = new Map();

function agentsById(snapshot) {
  return new Map(snapshot.agents.map(agent => [agent.id, agent]));
}

export function visiblePanelIds() {
  return [...openPanels.entries()]
    .filter(([, origin]) => origin !== PANEL_ORIGIN.SUPPRESSED)
    .map(([id]) => id)
    .sort(compareVisiblePanels);
}

export function reconcileOpenPanels(snapshot) {
  const byId = agentsById(snapshot);
  for (const agent of snapshot.agents) {
    if (agent.status === "running" && !openPanels.has(agent.id)) {
      openPanels.set(agent.id, PANEL_ORIGIN.AUTO);
    }
  }

  for (const [id, origin] of openPanels) {
    const stillRunning = byId.get(id)?.status === "running";
    if ((origin === PANEL_ORIGIN.AUTO || origin === PANEL_ORIGIN.SUPPRESSED) && !stillRunning) {
      openPanels.delete(id);
    }
  }
}

export function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareVisiblePanels(a, b) {
  const timeDiff = panelSortTime(a) - panelSortTime(b);
  if (timeDiff !== 0) return timeDiff;
  return agentOrder(a) - agentOrder(b);
}

function panelSortTime(agentId) {
  const agentTurns = state.turns?.agents.find(agent => agent.agentId === agentId)?.turns ?? [];
  if (agentTurns.length === 0) return Number.MAX_SAFE_INTEGER;

  const session = sessions.get(agentId);
  const selected = session?.pinnedTurn && session.currentTurnIndex !== null
    ? agentTurns[session.currentTurnIndex]
    : agentTurns.find(turn => turn.status === "running") ?? agentTurns[agentTurns.length - 1];

  return Date.parse(selected?.startTime ?? "") || Number.MAX_SAFE_INTEGER;
}

function agentOrder(agentId) {
  return state.snapshot?.agents.findIndex(agent => agent.id === agentId) ?? Number.MAX_SAFE_INTEGER;
}
