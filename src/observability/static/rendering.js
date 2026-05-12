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
  group.append(renderMailBlock("incoming", incomingMail(turn), `turn:${turn.turnId}:incoming`));
  group.append(renderWorkSummary(turn));
  for (const [idx, item] of outgoingMail(turn).entries()) {
    group.append(renderMailBlock("outgoing", item, `turn:${turn.turnId}:outgoing:${idx}`));
  }
  const outcome = turnOutcome(turn);
  if (outcome) group.append(renderTurnOutcome(outcome));
  return group;
}

function renderEventList(events) {
  const items = [];
  for (const group of groupRepeatedToolResults(events)) {
    const item = Array.isArray(group) ? renderToolResultGroup(group) : renderSessionEvent(group);
    if (item) items.push(item);
  }
  return items;
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

function renderMailBlock(dir, mail, detailKey) {
  const isEmpty = !mail?.body;
  const meta = el("div", { className: "turn-mail-meta" },
      el("span", { className: "turn-mail-dir", textContent: dir }),
      mail?.title ? el("span", { className: "turn-mail-title", textContent: mail.title }) : null,
  );

  if (isEmpty) {
    return el("section", { className: `turn-mail turn-mail-${dir} empty` }, meta);
  }

  return el("details", {
    className: `turn-mail turn-mail-${dir}`,
    dataset: { detailKey },
  },
    el("summary", {},
      meta,
      el("span", { className: "turn-mail-preview", textContent: mail.body }),
    ),
    el("pre", { className: "turn-mail-body text-block", textContent: mail.body }),
  );
}

function renderWorkSummary(turn) {
  const summary = workSummary(turn);
  const details = el("details", {
    className: `turn-work${turn.status === "running" ? " running" : ""}`,
    dataset: { detailKey: `turn:${turn.turnId}:work` },
  },
    el("summary", {},
      el("span", { className: "turn-work-label", textContent: summary }),
      el("span", { className: "turn-work-hint", textContent: "details" }),
    ),
  );
  details.append(el("div", { className: "turn-work-body" }, ...renderEventList(turn.events)));
  return details;
}

function renderTurnOutcome(outcome) {
  return el("section", { className: `turn-outcome turn-outcome-${outcome.type}` },
    el("span", { className: "turn-outcome-label", textContent: outcome.label }),
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

function incomingMail(turn) {
  const contextEvent = turn.events.find(event =>
    event.message?.role === "user" &&
    isFrameworkInput(firstTextContent(event.message.content))
  );
  const text = firstTextContent(contextEvent?.message?.content);
  const inbox = extractSection(text, "## Inbox", "## Active Mail Task");
  const activeTask = extractSection(text, "## Active Mail Task", "");
  const { title, body } = parseInboxMail(inbox);

  if (body || activeTask) {
    return {
      title: title || incomingTitle(turn),
      body: body || activeTask,
    };
  }

  if (turn.context.type === "reminder" && text) {
    return {
      title: "reminder",
      body: text,
    };
  }

  if (turn.context.type === "reply") {
    return {
      title: `reply to ${replyTarget(turn.context.label)}`,
      body: "",
    };
  }

  return {
    title: turn.context.type === "free" ? "free turn" : turn.context.label || turn.context.type,
    body: "",
  };
}

function outgoingMail(turn) {
  const mail = [];
  for (const event of turn.events) {
    if (event.message?.role !== "assistant") continue;
    for (const block of event.message.content ?? []) {
      if (block.type === "toolCall" && block.name === "sendMail") {
        mail.push(outgoingMailBlock(block));
      }
    }
  }
  return mail;
}

function outgoingMailBlock(block) {
  const to = block.arguments?.to ?? block.arguments?.recipient ?? block.input?.to ?? "?";
  return {
    title: `mail to ${to}`,
    body: block.arguments?.content ?? block.arguments?.message ?? block.input?.content ?? "",
  };
}

function turnOutcome(turn) {
  for (const event of [...turn.events].reverse()) {
    if (event.message?.role !== "assistant") continue;
    for (const block of [...(event.message.content ?? [])].reverse()) {
      if (block.type !== "toolCall") continue;
      if (block.name === "yield") return { type: "yield", label: "yielded" };
      if (block.name === "reply") return { type: "reply", label: "replied" };
    }
  }
  return null;
}

function workSummary(turn) {
  if (turn.status === "running") return currentPhase(turn);
  const labels = new Set();
  for (const event of turn.events) {
    if (event.message?.role === "assistant") {
      for (const block of event.message.content ?? []) {
        if (block.type === "thinking") labels.add("thinking");
        else if (block.type === "toolCall" && !["reply", "sendMail", "yield"].includes(block.name)) labels.add("tools");
        else if (block.type === "text" && preview(block.text)) labels.add("text");
      }
    }
  }
  const ordered = ["thinking", "tools", "text"].filter(label => labels.has(label));
  return ordered.join(", ") || "no work";
}

function currentPhase(turn) {
  const event = [...turn.events].reverse().find(item => item.live) ?? turn.events[turn.events.length - 1];
  if (!event) return "running";
  if (event.message?.role === "toolResult") return "reading results";
  if (event.message?.role !== "assistant") return "starting";

  const content = event.message.content ?? [];
  const last = [...content].reverse().find(block => block.type !== "text" || preview(block.text));
  if (!last) return "running";
  if (last.type === "thinking") return "thinking";
  if (last.type === "toolCall") {
    if (last.name === "reply" || last.name === "sendMail" || last.name === "yield") return "finishing";
    return "using tools";
  }
  if (last.type === "text") return "writing";
  return last.type ?? "running";
}

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const bodyStart = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, bodyStart) : -1;
  return text.slice(bodyStart, end === -1 ? undefined : end).trim();
}

function replyTarget(label = "") {
  return label.replace(/^⬅\s*/, "").trim() || "sender";
}

function incomingTitle(turn) {
  if (turn.context.type === "reply") return `reply to ${replyTarget(turn.context.label)}`;
  if (turn.context.type === "reminder") return "reminder";
  return "incoming mail";
}

function parseInboxMail(inbox) {
  if (!inbox) return { title: "", body: "" };
  const lines = inbox.split(/\n/);
  const headerIndex = lines.findIndex(line => line.startsWith("### "));
  if (headerIndex === -1) return { title: "incoming mail", body: inbox.trim() };

  const header = lines[headerIndex].replace(/^###\s*/, "").trim();
  const from = header.match(/From:\s*([^|]+)/)?.[1]?.trim();
  const body = lines.slice(headerIndex + 1).join("\n").trim();
  return {
    title: from ? `from ${from}` : "incoming mail",
    body,
  };
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

function isFrameworkInput(text = "") {
  return text.includes("## Framework Turn Context") || text.includes("## Framework Reminder");
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
