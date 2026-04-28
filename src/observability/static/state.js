export const PANEL_ORIGIN = {
  USER: "user",
  AUTO: "auto",
  SUPPRESSED: "suppressed",
};

export const state = {
  snapshot: null,
  panelHeights: new Map(),
};

export const openPanels = new Map();
export const sessions = new Map();

export function agentsById(snapshot) {
  return new Map(snapshot.agents.map(agent => [agent.id, agent]));
}

export function visiblePanelIds() {
  return [...openPanels.entries()]
    .filter(([, origin]) => origin !== PANEL_ORIGIN.SUPPRESSED)
    .map(([id]) => id);
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
