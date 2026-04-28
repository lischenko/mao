import { compactNumber, el, els } from "./dom.js";
import { sessions } from "./state.js";

const FRAMEWORK_TOOLS = new Set(["yield", "reply", "sendMail"]);

export function ensureSession(agentId) {
  if (!sessions.has(agentId)) sessions.set(agentId, { total: 0, lastIndex: null, inFlight: false });
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
    const data = await fetchSessionData(agentId, afterIndex);
    if (!sessions.has(agentId)) return;

    session.total = data.total;
    const list = sessionList(agentId);
    if (!list) return;

    if (data.events.length === 0) {
      if (afterIndex === null) list.replaceChildren(notice("No messages yet"));
      else list.querySelector(".sev-live")?.remove();
      return;
    }

    session.lastIndex = lastPersistedIndex(data.events, session.lastIndex);
    appendSessionItems(list, buildSessionItems(data.events), afterIndex !== null);
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
    formatDuration(agent.activity.durationMs),
    `${compactNumber(agent.activity.totalTokens)} tok`,
    agent.activity.totalCost ? `$${agent.activity.totalCost.toFixed(3)}` : "",
  ].filter(Boolean).join("  ·  ");
}

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

function appendSessionItems(list, items, incremental) {
  const liveOpenState = captureLiveOpenState(list);
  const hadLiveRow = Boolean(liveOpenState);
  restoreLiveOpenState(items, liveOpenState);
  const liveViewportState = liveViewportPosition(list);
  const wasNearBottom = !hadLiveRow && isNearBottom(list);
  const previousScrollHeight = list.scrollHeight;
  const previousScrollTop = list.scrollTop;
  list.querySelector(".sev-live")?.remove();
  if (incremental) {
    list.append(...items);
    restoreScrollPosition(list, { liveViewportState, wasNearBottom, previousScrollHeight, previousScrollTop });
    return;
  }
  list.replaceChildren(...items);
  if (hadLiveRow) restoreScrollPosition(list, { liveViewportState, wasNearBottom, previousScrollHeight, previousScrollTop });
  else list.scrollTop = list.scrollHeight;
}

function captureLiveOpenState(list) {
  const live = list.querySelector(".sev-live");
  if (!live) return null;
  return {
    thinking: [...live.querySelectorAll(".sev-thinking")].map(node => node.open),
    toolCalls: [...live.querySelectorAll(".sev-toolcall")].map(node => node.open),
  };
}

function restoreLiveOpenState(items, state) {
  if (!state) return;
  for (const item of items) {
    if (!item.classList?.contains("sev-live")) continue;
    item.querySelectorAll(".sev-thinking").forEach((node, index) => {
      if (state.thinking[index]) node.open = true;
    });
    item.querySelectorAll(".sev-toolcall").forEach((node, index) => {
      if (state.toolCalls[index] !== undefined) node.open = state.toolCalls[index];
    });
  }
}

function buildSessionItems(events) {
  return events.flatMap(event => {
    const msg = event.message;
    if (msg.role === "toolResult") {
      if (msg.toolName === "yield") return [el("hr", { className: "turn-sep" })];
      if (FRAMEWORK_TOOLS.has(msg.toolName)) return [];
    }
    const item = renderSessionEvent(event);
    return item ? [item] : [];
  });
}

function renderSessionEvent(event) {
  const msg = event.message;
  const summary = el("summary", {},
    el("span", { className: "sev-label", textContent: eventLabel(event) }),
    event.timestamp ? el("time", {
      className: "sev-ts",
      textContent: new Date(event.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    }) : null,
  );
  const details = el("details", {
    className: `sev sev-${msg.role ?? "other"}${event.live ? " sev-live" : ""}`,
    open: msg.role !== "toolResult",
  }, summary);

  const blocks = (msg.content ?? []).map(block => renderBlock(block, event)).filter(Boolean);
  if (blocks.length > 0) details.append(el("div", { className: "sev-body" }, ...blocks));
  return details;
}

function isNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

function restoreScrollPosition(list, state) {
  if (state.liveViewportState === "end-visible" || state.wasNearBottom) {
    list.scrollTop = list.scrollHeight;
    return;
  }
  if (state.liveViewportState !== "above") {
    list.scrollTop = state.previousScrollTop;
    return;
  }
  const heightDelta = list.scrollHeight - state.previousScrollHeight;
  list.scrollTop = state.previousScrollTop + heightDelta;
}

function liveViewportPosition(list) {
  const live = list.querySelector(".sev-live");
  if (!live) return "none";
  const listRect = list.getBoundingClientRect();
  const liveRect = live.getBoundingClientRect();
  if (liveRect.bottom <= listRect.bottom + 16) return "end-visible";
  if (liveRect.bottom <= listRect.top) return "above";
  if (liveRect.top >= listRect.bottom) return "below";
  return "intersecting";
}

function eventLabel(event) {
  const msg = event.message;
  if (event.live) return `${assistantLabel(msg)} ...`;
  if (msg.role === "toolResult") return msg.toolName ?? "tool";
  if (msg.role === "user") return preview(firstText(msg.content)) || "prompt";
  if (msg.role !== "assistant") return msg.role ?? "";

  const parts = (msg.content ?? []).flatMap(blockLabel);
  return parts.join(" · ") || "assistant";
}

function assistantLabel(msg) {
  if (msg.role !== "assistant") return msg.role ?? "";
  const parts = (msg.content ?? []).flatMap(blockLabel);
  return parts.join(" · ") || "assistant";
}

function blockLabel(block) {
  if (block.type === "toolCall") return toolCallLabel(block);
  if (block.type === "thinking") return ["thinking"];
  if (block.type === "text") return preview(block.text) ? [preview(block.text)] : [];
  return [block.type];
}

function toolCallLabel(block) {
  if (block.name === "yield") return [];
  if (block.name === "reply") {
    const text = block.arguments?.content ?? block.input?.content ?? "";
    return [preview(text) ? `reply: ${preview(text)}` : "reply"];
  }
  if (block.name === "sendMail") {
    const to = block.arguments?.to ?? block.arguments?.recipient ?? block.input?.to ?? "?";
    return [`-> ${to}`];
  }
  return [block.name ?? "tool"];
}

function renderBlock(block, event) {
  if (block.type === "text") {
    return el("pre", { className: "sev-text text-block", textContent: block.text ?? "" });
  }
  if (block.type === "thinking") {
    return el("details", { className: "sev-thinking" },
      el("summary", { textContent: `thinking · ${(block.thinking ?? "").length} chars` }),
      el("pre", { className: "sev-thinking-text text-block", textContent: block.thinking ?? "" }),
    );
  }
  if (block.type === "toolCall") return renderToolCall(block, event);
  return el("span", { className: "sev-unknown", textContent: `[${block.type}]` });
}

function renderToolCall(block, event) {
  if (block.name === "yield") return null;
  if (block.name === "reply") {
    return el("div", { className: "sev-reply text-block", textContent: block.arguments?.content ?? block.input?.content ?? "" });
  }
  if (block.name === "sendMail") {
    return el("div", { className: "sev-sendmail" },
      el("span", {
        className: "sev-sendmail-to",
        textContent: `-> ${block.arguments?.to ?? block.arguments?.recipient ?? block.input?.to ?? "?"}`,
      }),
      el("p", {
        className: "text-block",
        textContent: block.arguments?.content ?? block.arguments?.message ?? block.input?.content ?? "",
      }),
    );
  }
  if (block.name === "bash") {
    const command = block.arguments?.command ?? block.input?.command ?? "";
    return el("pre", { className: "sev-bash text-block", textContent: `bash$ ${command}` });
  }

  const details = el("details", { className: "sev-toolcall", open: true },
    el("summary", { textContent: block.name ?? "tool" }),
  );
  const args = block.arguments ?? block.input;
  if (args !== undefined) {
    details.append(el("pre", { textContent: stringify(args) }));
  }
  return details;
}

function firstText(content = []) {
  return content.find(block => block.type === "text")?.text ?? "";
}

function preview(text = "") {
  return text.slice(0, 60).replace(/\n/g, " ").trim();
}

function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function notice(text) {
  return el("p", { className: "sev-notice", textContent: text });
}

function lastPersistedIndex(events, fallback) {
  const persisted = events.filter(event => !event.live);
  return persisted.length > 0 ? persisted[persisted.length - 1].index : fallback;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
