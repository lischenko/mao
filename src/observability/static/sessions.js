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
    events: null, turns: null, currentTurnIndex: null, pinnedTurn: false,
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
  const seen = new Set();

  for (const event of events) {
    const def = turnForEvent(event, turnDefs);
    if (!def) continue;
    seen.add(def.turnId);

    if (!current || current.turnId !== def.turnId) {
      if (current) turns.push(current);
      current = {
        turnId: def.turnId,
        events: [],
        context: turnContext(def),
        startTime: def.startTime,
        endTime: def.endTime,
        status: def.status,
        sentMailTo: def.sentMailTo ?? [],
        inbox: def.inbox ?? [],
        produced: def.produced ?? [],
        activeMailId: def.activeMailId ?? null,
        replyToAgent: def.replyToAgent ?? null,
        replied: def.replied ?? false,
        tokenCount: 0,
      };
    }

    if (event.message?.role === "assistant" && event.message?.usage?.totalTokens) {
      current.tokenCount += event.message.usage.totalTokens;
    }

    current.events.push(event);
  }

  if (current) turns.push(current);
  return [
    ...turns,
    ...turnDefs.filter(def => !seen.has(def.turnId)).map(turnFromDef),
  ].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

function turnForEvent(event, turnDefs) {
  if (turnDefs.length === 0) return null;
  return turnDefs.find(turn => event.index === turn.startIndex)
    ?? turnDefs.find(turn =>
      turn.startIndex !== null &&
      event.index > turn.startIndex &&
      (turn.endIndex === null || event.index <= turn.endIndex)
    );
}

function turnFromDef(def) {
  return {
    turnId: def.turnId,
    events: [],
    context: turnContext(def),
    startTime: def.startTime,
    endTime: def.endTime,
    status: def.status,
    sentMailTo: def.sentMailTo ?? [],
    inbox: def.inbox ?? [],
    produced: def.produced ?? [],
    activeMailId: def.activeMailId ?? null,
    replyToAgent: def.replyToAgent ?? null,
    replied: def.replied ?? false,
    tokenCount: 0,
  };
}

function turnContext(def) {
  const type = turnContextType(def);
  return { type, label: turnContextLabel(def, type) };
}

function turnContextType(def) {
  if (def.activeMailId) return "reply";
  if ((def.inbox ?? []).some(message => message.from === "framework" && message.content.includes("## Framework Reminder"))) return "reminder";
  if ((def.produced ?? []).some(message => message.from === "human" && message.type === "mail" && message.expectsReply) && (def.inbox ?? []).length === 0) return "initial";
  return "free";
}

function turnContextLabel(def, type) {
  if (type === "reply" && def.replyToAgent) return `⬅ ${def.replyToAgent}`;
  if (type === "reminder") return "reminder";
  if (type === "initial") return "initial prompt";
  return "free turn";
}

function lastPersistedIndex(events, fallback) {
  const persisted = events.filter(event => !event.live);
  return persisted.length > 0 ? persisted[persisted.length - 1].index : fallback;
}
