// Role: Session data model. Fetches session events and turn definitions from API.
// Groups events into turns using backend turn indices (startIndex/endIndex).
// Boundary: No DOM, no navigation, no rendering—only data fetching and caching.

import { compactNumber, els, formatDurationMs, notice } from "./dom.js";
import { sessions, state } from "./state.js";
import { rerenderPanel } from "./navigation.js";

// ── Session lifecycle ──────────────────────────────────────────────

export function ensureSession(agentId) {
  if (!sessions.has(agentId)) sessions.set(agentId, {
    total: 0, lastIndex: null, inFlight: false,
    events: null, turns: null, currentTurnIndex: null,
  });
}

export function dropClosedSessions(openIds) {
  const keep = new Set(openIds);
  for (const id of sessions.keys()) {
    if (!keep.has(id)) sessions.delete(id);
  }
}

export function maybeFetchSession(agent) {
  const session = sessions.get(agent.id);
  if (!session || session.inFlight) return;
  fetchSession(agent.id, session.lastIndex);
}

export async function fetchSession(agentId, afterIndex = null) {
  const session = sessions.get(agentId);
  if (!session || session.inFlight) return;

  session.inFlight = true;
  try {
    const sessionData = await fetchSessionData(agentId, afterIndex);

    if (!sessions.has(agentId)) return;
    session.total = sessionData.total;

    if (sessionData.events.length === 0) {
      if (afterIndex === null) {
        sessionList(agentId)?.replaceChildren(notice("No messages yet"));
      }
      return;
    }

    session.lastIndex = lastPersistedIndex(sessionData.events, session.lastIndex);

    if (afterIndex === null) {
      session.events = sessionData.events;
    } else if (session.events) {
      mergeSessionEvents(session.events, sessionData.events);
    } else {
      session.events = sessionData.events;
    }

    // Group events into turns using backend turn definitions
    const agentTurnDefs = state.turns?.agents.find(a => a.agentId === agentId)?.turns ?? [];
    session.turns = groupEventsByTurn(session.events, agentTurnDefs);

    // Re-render
    rerenderPanel(agentId);
  } catch {
    if (afterIndex === null) {
      sessionList(agentId)?.replaceChildren(notice("Failed to load session"));
    }
  } finally {
    if (sessions.has(agentId)) session.inFlight = false;
  }
}

export function panelMeta(agent) {
  return [
    agent.role || agent.name || agent.personaId,
    agent.status,
    `${agent.turns.completed}/${agent.turns.total} turns`,
    formatDurationMs(agent.activity.durationMs),
    `${compactNumber(agent.activity.totalTokens)} tok`,
    agent.activity.totalCost ? `$${agent.activity.totalCost.toFixed(3)}` : "",
  ].filter(Boolean).join("  ·  ");
}

// ── Internals ──────────────────────────────────────────────────────

async function fetchSessionData(agentId, afterIndex) {
  const url = afterIndex !== null
    ? `/api/agents/${encodeURIComponent(agentId)}/session?after=${afterIndex}`
    : `/api/agents/${encodeURIComponent(agentId)}/session`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function sessionList(agentId) {
  return els.panelsContainer.querySelector(`[data-agent-id="${agentId}"] .session-list`);
}

function mergeSessionEvents(events, incoming) {
  const byIndex = new Map(events.map((event, idx) => [event.index, idx]));
  for (const event of incoming) {
    const existingIdx = byIndex.get(event.index);
    if (existingIdx === undefined) {
      byIndex.set(event.index, events.length);
      events.push(event);
      continue;
    }

    const existing = events[existingIdx];
    if (event.live || existing.live) {
      events[existingIdx] = event;
    }
  }
}

function groupEventsByTurn(events, turnDefs) {
  const turns = [];
  let current = null;

  for (const event of events) {
    // Find which turn (if any) contains this event index
    const def = turnDefs.find(t =>
      event.index >= t.startIndex &&
      (t.endIndex === null || event.index <= t.endIndex)
    );
    if (!def) continue;

    if (!current || current.turnId !== def.turnId) {
      if (current) turns.push(current);
      current = {
        turnId: def.turnId,
        events: [],
        context: { type: def.context ?? "free", label: turnContextLabel(def) },
        startTime: def.startTime,
        endTime: def.endTime,
        status: def.status,
        sentMailTo: def.sentMailTo ?? [],
        tokenCount: 0,
      };
    }

    if (event.message?.role === "assistant" && event.message?.usage?.totalTokens) {
      current.tokenCount += event.message.usage.totalTokens;
    }

    current.events.push(event);
  }

  if (current) turns.push(current);
  return turns;
}

function turnContextLabel(def) {
  if (def.context === "reply" && def.replyToAgent) return `⬅ ${def.replyToAgent}`;
  if (def.context === "reminder") return "reminder";
  return "free turn";
}

function lastPersistedIndex(events, fallback) {
  const persisted = events.filter(event => !event.live);
  return persisted.length > 0 ? persisted[persisted.length - 1].index : fallback;
}
