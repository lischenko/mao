// Role: Turn navigation controller. Handles prev/next clicks and re-renders panels
// from cached data.
// Boundary: Calls rendering module; owns no data beyond turn index. Turn selection
// side effects are supplied by app.js.

import { els } from "./dom.js";
import { sessions } from "./state.js";
import { notice } from "./dom.js";
import { renderTurn, renderTurnEdge } from "./rendering.js";

let onTurnSelected = () => {};
const openDetailsByAgent = new Map();

export function setTurnSelectedHandler(fn) {
  onTurnSelected = typeof fn === "function" ? fn : () => {};
}

// ── Turn index management ──────────────────────────────────────────

function getTurns(agentId) {
  return sessions.get(agentId)?.turns ?? [];
}

function getTurnIndex(agentId) {
  const session = sessions.get(agentId);
  if (!session) return 0;
  if (session.currentTurnIndex !== null && session.pinnedTurn) return session.currentTurnIndex;
  return activeTurnIndex(session.turns ?? []);
}

function setTurnIndex(agentId, idx, pinned = false) {
  const s = sessions.get(agentId);
  if (!s) return;
  s.currentTurnIndex = idx;
  s.pinnedTurn = pinned;
}

function sessionList(agentId) {
  return els.panelsContainer.querySelector(`[data-agent-id="${agentId}"] .session-list`);
}

// ── Re-render ──────────────────────────────────────────────────────

export function rerenderPanel(agentId) {
  const list = sessionList(agentId);
  if (!list) return;

  rememberOpenDetails(agentId, list);

  const turns = getTurns(agentId);
  if (turns.length === 0) {
    list.replaceChildren(notice("No turns"));
    return;
  }

  const total = turns.length;
  const idx = Math.max(0, Math.min(total - 1, getTurnIndex(agentId)));
  setTurnIndex(agentId, idx, sessions.get(agentId)?.pinnedTurn ?? false);

  const items = [];

  if (idx > 0) {
    items.push(renderTurnEdge("prev", turns[idx - 1], idx, () => {
      navigateToTurn(agentId, idx - 1);
    }));
  }

  items.push(renderTurn(agentId, turns[idx], idx + 1, total));

  if (idx < total - 1) {
    items.push(renderTurnEdge("next", turns[idx + 1], idx + 2, () => {
      navigateToTurn(agentId, idx + 1);
    }));
  }

  list.replaceChildren(...items);
  restoreOpenDetails(agentId, list);
}

export function navigateToTurn(agentId, idx) {
  setTurnIndex(agentId, idx, true);
  const turn = getTurns(agentId)[idx];
  if (turn) onTurnSelected(turn.turnId);
  rerenderPanel(agentId);
}

export function followLiveTurn(agentId) {
  const turns = getTurns(agentId);
  if (turns.length === 0) return;

  const idx = activeTurnIndex(turns);
  setTurnIndex(agentId, idx, false);
  const turn = turns[idx];
  if (turn) onTurnSelected(turn.turnId);
  rerenderPanel(agentId);
}

// ── Focus turn from timeline click (retries if session not loaded) ─

export function handleFocusTurn(agentId, turnId) {
  tryFocusTurn(agentId, turnId, 0);
}

function tryFocusTurn(agentId, turnId, attempt) {
  const turns = getTurns(agentId);

  if (!turns.length && attempt < 30) {
    setTimeout(() => tryFocusTurn(agentId, turnId, attempt + 1), 100);
    return;
  }

  const idx = turns.findIndex(t => t.turnId === turnId);
  if (idx === -1) return;

  navigateToTurn(agentId, idx);

  // Flash highlight in transcript
  requestAnimationFrame(() => {
    const panel = els.panelsContainer.querySelector(`[data-agent-id="${agentId}"]`);
    if (!panel) return;
    const group = panel.querySelector(`[data-turn-id="${turnId}"]`);
    if (!group) return;
    group.scrollIntoView({ behavior: "smooth", block: "start" });
    group.style.transition = "none";
    group.style.background = "rgba(29, 111, 184, 0.12)";
    requestAnimationFrame(() => {
      group.style.transition = "background 0.8s";
      group.style.background = "";
    });
  });
}

function rememberOpenDetails(agentId, root) {
  const openDetails = openDetailsByAgent.get(agentId) ?? new Map();
  openDetailsByAgent.set(agentId, openDetails);
  for (const detail of root.querySelectorAll("details[data-detail-key]")) {
    openDetails.set(detail.dataset.detailKey, detail.open);
  }
}

function restoreOpenDetails(agentId, root) {
  const openDetails = openDetailsByAgent.get(agentId);
  if (!openDetails) return;
  for (const detail of root.querySelectorAll("details[data-detail-key]")) {
    const key = detail.dataset.detailKey;
    if (openDetails.has(key)) detail.open = openDetails.get(key);
    detail.addEventListener("toggle", () => {
      openDetails.set(key, detail.open);
    });
  }
}

function activeTurnIndex(turns) {
  const running = turns.findIndex(turn => turn.status === "running");
  return running === -1 ? Math.max(0, turns.length - 1) : running;
}
