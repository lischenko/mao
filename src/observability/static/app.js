import { els, setConnection } from "./dom.js";
import { renderConnectors, renderGraph } from "./graph.js";
import { applyPanelHeights, installPanelDrag, renderPanels } from "./panels.js";
import { openPanels, PANEL_ORIGIN, state } from "./state.js";

async function refresh() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = await res.json();
    state.snapshot = snapshot;
    render(snapshot);
    setConnection("live", "ok");
  } catch {
    setConnection("offline", "error");
  }
}

function render(snapshot) {
  els.projectName.textContent = projectTitle(snapshot);
  els.projectMeta.textContent = `${snapshot.workflow.name} · ${snapshot.repo}`;
  renderStatusCounts(snapshot);
  renderGraph(snapshot, togglePanel);
  renderPanels(snapshot, renderConnectors, render);
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
  if (state.snapshot) render(state.snapshot);
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
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

window.addEventListener("resize", () => {
  if (!state.snapshot) return;
  renderGraph(state.snapshot, togglePanel);
  applyPanelHeights();
  renderConnectors(state.snapshot);
});

installPanelDrag(renderConnectors);
refresh();
setInterval(refresh, 1000);
