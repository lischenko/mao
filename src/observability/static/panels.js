// Role: Panel layout manager. Creates/removes agent panels, handles divider drag.
// Boundary: No data fetching, no rendering—only panel DOM construction and layout.

import { el, els } from "./dom.js";
import { getAgentColor } from "./colors.js";
import {
  arraysEqual,
  openPanels,
  PANEL_ORIGIN,
  reconcileOpenPanels,
  sessions,
  state,
  visiblePanelIds,
} from "./state.js";
import { followLiveTurn } from "./navigation.js";
import { dropClosedSessions, ensureSession, fetchSession, maybeFetchSession, panelMeta } from "./sessions.js";

const DIVIDER_WIDTH = 5;
const MIN_PANEL_WIDTH = 200;

let dragState = null;

export function renderPanels(snapshot) {
  reconcileOpenPanels(snapshot);
  const ids = visiblePanelIds();
  reconcilePanelElements(ids);

  const byId = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  for (const id of ids) {
    const agent = byId.get(id);
    if (!agent) continue;
    updatePanelHeader(id, agent);
    maybeFetchSession(agent);
  }
}

export function installPanelDrag() {
  window.addEventListener("mousemove", event => {
    if (!dragState) return;

    const leftPanel = panelElement(dragState.leftId);
    const rightPanel = panelElement(dragState.rightId);
    if (!leftPanel || !rightPanel) return;

    const delta = event.clientX - dragState.startX;
    const newLeft = Math.max(MIN_PANEL_WIDTH, dragState.startLeft + delta);
    const newRight = Math.max(MIN_PANEL_WIDTH, dragState.startRight - delta);

    leftPanel.style.flex = `0 0 ${newLeft}px`;
    rightPanel.style.flex = `0 0 ${newRight}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragState) return;
    dragState = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ── Internals ──────────────────────────────────────────────────────

function reconcilePanelElements(ids) {
  const currentIds = currentPanelIds();
  if (arraysEqual(ids, currentIds)) return;

  const existing = new Map(
    [...els.panelsContainer.querySelectorAll(".agent-panel")].map(p => [p.dataset.agentId, p]),
  );
  els.panelsContainer.replaceChildren();
  ids.forEach((id, index) => {
    if (index > 0) els.panelsContainer.append(createDivider());
    const panel = existing.get(id) ?? createPanel(id);
    els.panelsContainer.append(panel);
    if (!existing.has(id)) {
      ensureSession(id);
      fetchSession(id);
    }
  });

  dropClosedSessions(ids);
}

function createPanel(id) {
  return el("div", { className: "agent-panel", dataset: { agentId: id } },
    el("div", { className: "agent-header" }),
    el("div", { className: "session-list" }),
  );
}

function updatePanelHeader(id, agent) {
  const header = els.panelsContainer.querySelector(`[data-agent-id="${id}"] .agent-header`);
  if (!header) return;
  header.style.borderLeftColor = getAgentColor(id);
  header.classList.toggle("running", agent.status === "running");
  header.replaceChildren(
    el("span", { className: "agent-header-id", textContent: agent.id }),
    el("span", { className: "agent-header-meta", textContent: panelMeta(agent) }),
    followStateButton(id, agent),
    closeButton(id),
  );
}

function followStateButton(id, agent) {
  const pinned = sessions.get(id)?.pinnedTurn ?? false;
  const label = pinned ? "pinned" : agent.status === "running" ? "following live" : "following latest";
  const button = el("button", {
    className: `panel-follow${pinned ? " pinned" : ""}`,
    textContent: label,
    title: pinned ? "Static past turn. Click to follow live/latest turn." : "Auto-following the active/latest turn.",
  });

  button.disabled = !pinned;
  button.addEventListener("click", event => {
    event.stopPropagation();
    followLiveTurn(id);
  });
  return button;
}

function closeButton(id) {
  const button = el("button", { className: "panel-close", textContent: "x" });
  button.addEventListener("click", event => {
    event.stopPropagation();
    const agentStatus = state.snapshot?.agents.find(agent => agent.id === id)?.status;
    if (agentStatus === "running") openPanels.set(id, PANEL_ORIGIN.SUPPRESSED);
    else openPanels.delete(id);
    if (state.snapshot) renderPanels(state.snapshot);
  });
  return button;
}

function createDivider() {
  const divider = el("div", { className: "panel-divider" });
  divider.addEventListener("mousedown", event => {
    event.preventDefault();
    const ids = currentPanelIds();
    const leftId = ids[currentDividerIndex(divider)];
    const rightId = ids[currentDividerIndex(divider) + 1];
    const leftPanel = panelElement(leftId);
    const rightPanel = panelElement(rightId);
    if (!leftPanel || !rightPanel) return;

    dragState = {
      leftId,
      rightId,
      startX: event.clientX,
      startLeft: leftPanel.getBoundingClientRect().width,
      startRight: rightPanel.getBoundingClientRect().width,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  return divider;
}

function currentDividerIndex(divider) {
  return [...els.panelsContainer.children].indexOf(divider);
}

function panelElement(id) {
  return els.panelsContainer.querySelector(`[data-agent-id="${id}"]`);
}

function currentPanelIds() {
  return [...els.panelsContainer.querySelectorAll(".agent-panel")].map(p => p.dataset.agentId);
}
