import { el, els, statusColor } from "./dom.js";
import {
  arraysEqual,
  openPanels,
  PANEL_ORIGIN,
  reconcileOpenPanels,
  state,
  visiblePanelIds,
} from "./state.js";
import { dropClosedSessions, ensureSession, fetchSession, maybeFetchSession, panelMeta } from "./sessions.js";

const DIVIDER_HEIGHT = 5;
const MIN_PANEL_HEIGHT = 80;

let dragState = null;

export function renderPanels(snapshot, onRenderConnectors, onRender) {
  reconcileOpenPanels(snapshot);
  const ids = visiblePanelIds();
  reconcilePanelElements(ids);

  const byId = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  for (const id of ids) {
    const agent = byId.get(id);
    if (!agent) continue;
    updatePanelHeader(id, agent, onRender);
    maybeFetchSession(agent);
  }

  requestAnimationFrame(() => onRenderConnectors(snapshot));
}

export function applyPanelHeights(ids = currentPanelIds()) {
  const available = availablePanelHeight(ids);
  const defaultProp = 1 / Math.max(1, ids.length);

  for (const id of ids) {
    if (!state.panelHeights.has(id)) state.panelHeights.set(id, defaultProp);
  }
  for (const id of [...state.panelHeights.keys()]) {
    if (!ids.includes(id)) state.panelHeights.delete(id);
  }

  setPanelFlex(available, defaultProp);
}

export function installPanelDrag(onRenderConnectors) {
  window.addEventListener("mousemove", event => {
    if (!dragState) return;

    const available = availablePanelHeight(dragState.ids);
    const minProp = MIN_PANEL_HEIGHT / available;
    const total = dragState.startTop + dragState.startBottom;
    const nextTop = dragState.startTop + (event.clientY - dragState.startY) / available;
    const topProp = Math.max(minProp, Math.min(nextTop, total - minProp));

    state.panelHeights.set(dragState.topId, topProp);
    state.panelHeights.set(dragState.bottomId, total - topProp);
    setPanelFlex(available);
    if (state.snapshot) onRenderConnectors(state.snapshot);
  });

  window.addEventListener("mouseup", () => {
    if (!dragState) return;
    dragState = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

function reconcilePanelElements(ids) {
  const currentIds = currentPanelIds();
  if (arraysEqual(ids, currentIds)) return;

  const existing = new Map([...els.panelsContainer.querySelectorAll(".agent-panel")].map(panel => [panel.dataset.agentId, panel]));
  els.panelsContainer.replaceChildren();
  ids.forEach((id, index) => {
    if (index > 0) els.panelsContainer.append(createDivider(index - 1));
    const panel = existing.get(id) ?? createPanel(id);
    els.panelsContainer.append(panel);
    if (!existing.has(id)) {
      ensureSession(id);
      fetchSession(id);
    }
  });

  dropClosedSessions(ids);
  state.panelHeights.clear();
  applyPanelHeights(ids);
}

function createPanel(id) {
  return el("div", { className: "agent-panel", dataset: { agentId: id } },
    el("div", { className: "agent-header" }),
    el("div", { className: "session-list" }),
  );
}

function updatePanelHeader(id, agent, onRender) {
  const header = els.panelsContainer.querySelector(`[data-agent-id="${id}"] .agent-header`);
  if (!header) return;
  header.style.borderLeftColor = statusColor(agent.status);
  header.replaceChildren(
    el("span", { className: "agent-header-id", textContent: agent.id }),
    el("span", { className: "agent-header-meta", textContent: panelMeta(agent) }),
    closeButton(id, onRender),
  );
}

function closeButton(id, onRender) {
  const button = el("button", { className: "panel-close", textContent: "x" });
  button.addEventListener("click", event => {
    event.stopPropagation();
    const agentStatus = state.snapshot?.agents.find(agent => agent.id === id)?.status;
    if (agentStatus === "running") openPanels.set(id, PANEL_ORIGIN.SUPPRESSED);
    else openPanels.delete(id);
    if (state.snapshot) onRender(state.snapshot);
  });
  return button;
}

function createDivider(topIndex) {
  const divider = el("div", { className: "panel-divider" });
  divider.addEventListener("mousedown", event => {
    event.preventDefault();
    const ids = currentPanelIds();
    dragState = {
      topId: ids[topIndex],
      bottomId: ids[topIndex + 1],
      ids,
      startY: event.clientY,
      startTop: state.panelHeights.get(ids[topIndex]) ?? (1 / ids.length),
      startBottom: state.panelHeights.get(ids[topIndex + 1]) ?? (1 / ids.length),
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  });
  return divider;
}

function setPanelFlex(available, fallbackProp = 0) {
  els.panelsContainer.querySelectorAll(".agent-panel").forEach(panel => {
    const prop = state.panelHeights.get(panel.dataset.agentId) ?? fallbackProp;
    panel.style.flex = `0 0 ${Math.round(prop * available)}px`;
  });
}

function availablePanelHeight(ids) {
  return els.panelsContainer.clientHeight - Math.max(0, ids.length - 1) * DIVIDER_HEIGHT;
}

function currentPanelIds() {
  return [...els.panelsContainer.querySelectorAll(".agent-panel")].map(panel => panel.dataset.agentId);
}
