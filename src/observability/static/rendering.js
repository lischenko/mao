// Role: Pure DOM producers. Stateless functions: session/event data in, DOM elements out.
// Boundary: No fetch, no state mutation, no navigation logic—only element creation.

import { compactNumber, el, formatDurationMs } from "./dom.js";
import { getAgentColor } from "./colors.js";

// ── Turn-level rendering ──────────────────────────────────────────

export function renderTurn(agentId, turn, num, total) {
  const group = el("div", {
    className: "turn-group",
    dataset: { turnId: turn.turnId, agentId },
  });
  group.append(renderTurnBanner(agentId, turn, num, total));
  for (const events of groupRepeatedToolResults(turn.events)) {
    const item = Array.isArray(events) ? renderToolResultGroup(events) : renderSessionEvent(events);
    if (item) group.append(item);
  }
  return group;
}

export function renderTurnEdge(dir, turn, labelNum, onClick) {
  const ctx = turn.context;
  let desc = `Turn ${labelNum}`;
  if (ctx.type === "reply" && ctx.label) desc += ` · ${ctx.label}`;
  else if (ctx.type === "reminder") desc += " · ⚠";
  else desc += " · free";

  const edge = el("div", { className: `turn-edge turn-edge-${dir}` },
    el("button", { className: "turn-edge-btn", textContent: dir === "prev" ? "◀" : "▶" }),
    el("span", { className: "turn-edge-desc", textContent: desc }),
  );
  edge.addEventListener("click", onClick);
  return edge;
}

function renderTurnBanner(agentId, turn, num, total) {
  const parts = [`Turn ${num}/${total}`];
  const ctx = turn.context;

  let ctxClass = "";
  if (ctx.type === "reply") {
    parts.push(ctx.label);
    ctxClass = "reply";
  } else if (ctx.type === "reminder") {
    parts.push("⚠ reminder");
    ctxClass = "reminder";
  } else {
    parts.push("free");
  }

  if (turn.sentMailTo?.length) {
    parts.push(`✉ ${turn.sentMailTo.join(", ")}`);
  }

  const stats = [];
  if (turn.tokenCount > 0) stats.push(`${compactNumber(turn.tokenCount)} tok`);
  if (turn.startTime && turn.endTime) {
    const ms = new Date(turn.endTime) - new Date(turn.startTime);
    if (ms > 1000) stats.push(formatDurationMs(ms));
  }

  return el("div", {
    className: `turn-banner${turn.status === "running" ? " running" : ""}`,
    style: { "--agent-color": getAgentColor(agentId) },
  },
    el("span", { className: "turn-banner-label", textContent: parts.join(" · ") }),
    ctxClass ? el("span", { className: `turn-banner-context ${ctxClass}`, textContent: "" }) : null,
    stats.length ? el("span", { className: "turn-banner-stats", textContent: stats.join(" · ") }) : null,
  );
}

// ── Event-level rendering ─────────────────────────────────────────

function renderSessionEvent(event) {
  const msg = event.message;
  const label = eventLabel(event);
  const key = eventKey(event);

  const isFRMContext = msg.role === "user"
    && firstTextContent(msg.content).includes("## Framework Turn Context");
  const defaultOpen = msg.role !== "toolResult" && !isFRMContext;

  const summary = el("summary", {},
    el("span", { className: "sev-kind", textContent: label.kind }),
    label.preview ? el("span", { className: "sev-preview", textContent: label.preview }) : null,
    event.timestamp ? el("time", {
      className: "sev-ts",
      textContent: new Date(event.timestamp).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }),
    }) : null,
  );
  const details = el("details", {
    className: `sev sev-${msg.role ?? "other"}${event.live ? " sev-live" : ""}`,
    dataset: { detailKey: key },
    open: defaultOpen,
  }, summary);

  const blocks = (msg.content ?? []).map((block, idx) => renderBlock(block, key, idx)).filter(Boolean);
  if (blocks.length > 0) details.append(el("div", { className: "sev-body" }, ...blocks));
  return details;
}

function renderBlock(block, eventKey, idx) {
  if (block.type === "text") {
    return el("pre", { className: "sev-text text-block", textContent: block.text ?? "" });
  }
  if (block.type === "thinking") {
    return el("details", {
      className: "sev-thinking",
      dataset: { detailKey: `${eventKey}:thinking:${idx}` },
    },
      el("summary", { textContent: `thinking · ${(block.thinking ?? "").length} chars` }),
      el("pre", { className: "sev-thinking-text text-block", textContent: block.thinking ?? "" }),
    );
  }
  if (block.type === "toolCall") return renderToolCall(block, `${eventKey}:tool:${idx}`);
  return el("span", { className: "sev-unknown", textContent: `[${block.type}]` });
}

function renderToolCall(block, detailKey) {
  if (block.name === "yield") return null;
  if (block.name === "reply") {
    return el("div", {
      className: "sev-reply text-block",
      textContent: block.arguments?.content ?? block.input?.content ?? "",
    });
  }
  if (block.name === "sendMail") {
    const to = block.arguments?.to ?? block.input?.to ?? "?";
    const content = block.arguments?.content ?? block.input?.content ?? "";
    return el("div", { className: "sev-sendmail" },
      el("span", { className: "sev-sendmail-to", textContent: `Mail to ${to}` }),
      el("p", { className: "text-block", textContent: content }),
    );
  }
  if (block.name === "bash") {
    const command = block.arguments?.command ?? block.input?.command ?? "";
    return el("pre", { className: "sev-bash text-block", textContent: `bash$ ${command}` });
  }

  const details = el("details", { className: "sev-toolcall", dataset: { detailKey }, open: true },
    el("summary", { textContent: block.name ?? "tool" }),
  );
  const args = block.arguments ?? block.input;
  if (args !== undefined) {
    details.append(el("pre", { textContent: stringify(args) }));
  }
  return details;
}

// ── Label helpers ──────────────────────────────────────────────────

function eventLabel(event) {
  const msg = event.message;
  if (event.live) {
    const label = assistantLabel(msg);
    return { ...label, preview: label.preview ? `${label.preview} ...` : "..." };
  }
  if (msg.role === "toolResult") return { kind: msg.toolName ?? "tool", preview: "" };
  if (msg.role === "user") return userLabel(msg);
  if (msg.role !== "assistant") return { kind: msg.role ?? "", preview: "" };
  return assistantLabel(msg);
}

function assistantLabel(msg) {
  if (msg.role !== "assistant") return { kind: msg.role ?? "", preview: "" };
  const parts = (msg.content ?? []).flatMap(blockLabel);
  return { kind: "Assistant turn", preview: compactLabels(parts).join(" · ") };
}

function userLabel(msg) {
  const text = firstText(msg.content);
  if (text.startsWith("## Framework Turn Context")) {
    return { kind: "Turn context", preview: "" };
  }
  const textPreview = preview(text);
  return { kind: "Prompt", preview: textPreview };
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

function groupRepeatedToolResults(events) {
  const grouped = [];
  for (const event of events) {
    const previous = grouped[grouped.length - 1];
    if (isToolResult(event) && Array.isArray(previous) && previous[0].message.toolName === event.message.toolName) {
      previous.push(event);
    } else if (isToolResult(event)) {
      grouped.push([event]);
    } else {
      grouped.push(event);
    }
  }
  return grouped.map(item => Array.isArray(item) && item.length === 1 ? item[0] : item);
}

function renderToolResultGroup(events) {
  const toolName = events[0].message.toolName ?? "tool";
  const details = el("details", {
    className: "sev sev-toolResult sev-toolGroup",
    dataset: { detailKey: `toolrun:${events[0].index}:${events[events.length - 1].index}:${toolName}` },
  },
    el("summary", {},
      el("span", { className: "sev-kind", textContent: `${toolName} x${events.length}` }),
      el("span", { className: "sev-preview", textContent: "consecutive results" }),
    ),
  );
  details.append(el("div", { className: "sev-body" }, ...events.map(renderSessionEvent).filter(Boolean)));
  return details;
}

function isToolResult(event) {
  return event.message?.role === "toolResult";
}

function compactLabels(labels) {
  const compacted = [];
  for (const label of labels) {
    const previous = compacted[compacted.length - 1];
    if (previous?.label === label) previous.count++;
    else compacted.push({ label, count: 1 });
  }
  return compacted.map(item => item.count > 1 ? `${item.label} x${item.count}` : item.label);
}

function eventKey(event) {
  return `event:${event.index ?? event.timestamp ?? ""}:${event.live ? "live" : "persisted"}`;
}

// ── Utilities ──────────────────────────────────────────────────────

function firstTextContent(content = []) {
  for (const block of content) {
    if (block?.type === "text") return block.text ?? "";
  }
  return "";
}

function firstText(content = []) {
  return content.find(block => block.type === "text")?.text ?? "";
}

function preview(text = "") {
  return text.slice(0, 60).replace(/\n/g, " ").trim();
}

function stringify(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
