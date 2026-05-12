// Role: Orchestrator. Runs the refresh loop, wires modules together.
// Boundary: The only module allowed to import from all others.

import { els, setConnection, compactNumber } from "./dom.js";
import { installPanelDrag, renderPanels } from "./panels.js";
import { openPanels, PANEL_ORIGIN, state } from "./state.js";
import { createTimeline } from "./timeline-grid.js";
import { handleFocusTurn, setTurnSelectedHandler } from "./navigation.js";

const timeline = createTimeline(document.getElementById("timeline"), {
  onAgentClick: togglePanel,
  onTurnClick: (agentId, turnId) => {
    if (!openPanels.has(agentId) || openPanels.get(agentId) === PANEL_ORIGIN.SUPPRESSED) {
      openPanels.set(agentId, PANEL_ORIGIN.USER);
      if (state.snapshot) renderApp(state.snapshot, state.turns);
    }
    handleFocusTurn(agentId, turnId);
  },
});

setTurnSelectedHandler((turnId) => timeline.highlightTurn(turnId));

async function refresh() {
  try {
    const [statusRes, turnsRes] = await Promise.all([
      fetch("/api/status", { cache: "no-store" }),
      fetch("/api/turns", { cache: "no-store" }),
    ]);
    if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
    if (!turnsRes.ok) throw new Error(`HTTP ${turnsRes.status}`);
    const snapshot = await statusRes.json();
    const turns = await turnsRes.json();
    state.snapshot = snapshot;
    state.turns = turns;
    renderApp(snapshot, turns);
    setConnection("live", "ok");
  } catch {
    setConnection("offline", "error");
  }
}

function renderApp(snapshot, turns = state.turns) {
  els.projectName.textContent = projectTitle(snapshot);
  els.projectMeta.textContent = `${snapshot.workflow.name} · ${snapshot.repo}`;
  renderStatusCounts(snapshot);
  timeline.render(turns);
  renderPanels(snapshot);
}

function projectTitle(snapshot) {
  const parts = [snapshot.project];
  const duration = formatDuration(snapshot.totals.durationMs);
  if (duration) parts.push(duration);
  if (snapshot.totals.totalTokens > 0) parts.push(`${compactNumber(snapshot.totals.totalTokens)} tok`);
  return parts.join(" · ");
}

function renderStatusCounts(snapshot) {
  const { agents, running, waiting, error } = snapshot.totals;
  const parts = [`${agents} agent${agents !== 1 ? "s" : ""}`];
  if (running) parts.push(`${running} running`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (error) parts.push(`${error} error${error !== 1 ? "s" : ""}`);
  els.statusCounts.textContent = parts.join(" · ");
}

function togglePanel(agentId) {
  if (openPanels.get(agentId) === PANEL_ORIGIN.USER) openPanels.delete(agentId);
  else openPanels.set(agentId, PANEL_ORIGIN.USER);
  if (state.snapshot) renderApp(state.snapshot, state.turns);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

installPanelDrag();
refresh();
setInterval(refresh, 1000);
