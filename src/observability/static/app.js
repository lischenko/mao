const state = {
  snapshot: null,
  selectedAgentId: null,
  timer: null,
};

const els = {
  projectName: document.getElementById("project-name"),
  projectMeta: document.getElementById("project-meta"),
  connection: document.getElementById("connection-state"),
  summary: document.getElementById("summary"),
  graph: document.querySelector(".graph-wrap"),
  edges: document.getElementById("edges"),
  nodes: document.getElementById("nodes"),
  empty: document.getElementById("empty-state"),
  details: document.getElementById("details"),
  fields: document.getElementById("agent-fields"),
};

const metrics = [
  ["agents", "Agents"],
  ["ready", "Ready"],
  ["running", "Running"],
  ["waiting", "Waiting"],
  ["idle", "Idle"],
  ["inbox", "Inbox"],
  ["openMail", "Open mail"],
  ["completedTurns", "Turns"],
];

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    state.snapshot = snapshot;
    if (!state.selectedAgentId && snapshot.agents.length > 0) {
      state.selectedAgentId = snapshot.agents[0].id;
    }
    render(snapshot);
    setConnection("Live", "ok");
  } catch (err) {
    setConnection("Offline", "error");
  }
}

function render(snapshot) {
  els.projectName.textContent = snapshot.project;
  els.projectMeta.textContent = `${snapshot.workflow.name} (${snapshot.workflow.id}) - ${snapshot.repo}`;
  renderSummary(snapshot);
  renderGraph(snapshot);
  renderDetails(snapshot);
}

function renderSummary(snapshot) {
  els.summary.replaceChildren(...metrics.map(([key, label]) => {
    const item = document.createElement("div");
    item.className = "metric";

    const labelEl = document.createElement("span");
    labelEl.className = "metric-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "metric-value";
    valueEl.textContent = String(snapshot.totals[key] ?? 0);

    item.append(labelEl, valueEl);
    return item;
  }));
}

function renderGraph(snapshot) {
  const rect = els.graph.getBoundingClientRect();
  const layout = layoutAgents(snapshot.agents, rect.width, rect.height);
  const activityScale = graphActivityScale(snapshot.agents);
  els.empty.classList.toggle("hidden", snapshot.agents.length > 0);

  els.nodes.replaceChildren(...snapshot.agents.map((agent) => renderNode(agent, layout.get(agent.id), activityScale)));
  renderEdges(snapshot, layout);
}

function renderNode(agent, point, activityScale) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `node ${agent.status}${state.selectedAgentId === agent.id ? " selected" : ""}`;
  button.style.left = `${point.x}px`;
  button.style.top = `${point.y}px`;
  button.addEventListener("click", () => {
    state.selectedAgentId = agent.id;
    render(state.snapshot);
  });

  const header = document.createElement("span");
  header.className = "node-header";

  const id = document.createElement("span");
  id.className = "node-id";
  id.textContent = agent.id;

  header.append(id);
  if (agent.inbox > 0) {
    const inbox = document.createElement("span");
    inbox.className = "node-inbox";
    inbox.title = "Inbox messages";
    inbox.textContent = String(agent.inbox);
    header.append(inbox);
  }

  const stats = document.createElement("span");
  stats.className = "node-stats";
  stats.textContent = nodeStats(agent);

  const latest = document.createElement("span");
  latest.className = "node-latest";
  latest.textContent = activitySummary(agent);

  const bars = activityBars(agent, activityScale);

  const tokens = tokenBar(agent, activityScale);

  button.append(header, stats, latest, bars, tokens);
  return button;
}

function renderEdges(snapshot, layout) {
  const rect = els.graph.getBoundingClientRect();
  els.edges.setAttribute("viewBox", `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
  els.edges.replaceChildren();

  const defs = svg("defs");
  const marker = svg("marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto-start-reverse",
  });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#a7b0bd" }));
  defs.append(marker);
  els.edges.append(defs);

  for (const edge of snapshot.communicationEdges ?? []) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) continue;
    if (edge.count <= edge.openCount) continue;

    const line = svg("line", {
      class: "edge history-edge",
      x1: String(from.x),
      y1: String(from.y),
      x2: String(to.x),
      y2: String(to.y),
    });
    els.edges.append(line);

    const label = svg("text", {
      class: "edge-label history-label",
      x: String((from.x + to.x) / 2),
      y: String((from.y + to.y) / 2 + 14),
      "text-anchor": "middle",
    });
    label.textContent = String(edge.count);
    els.edges.append(label);
  }

  for (const edge of snapshot.waitEdges) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) continue;

    const line = svg("line", {
      class: "edge",
      x1: String(from.x),
      y1: String(from.y),
      x2: String(to.x),
      y2: String(to.y),
      "marker-end": "url(#arrow)",
    });
    els.edges.append(line);

    const label = svg("text", {
      class: "edge-label",
      x: String((from.x + to.x) / 2),
      y: String((from.y + to.y) / 2 - 8),
      "text-anchor": "middle",
    });
    label.textContent = "wait";
    els.edges.append(label);
  }
}

function layoutAgents(agents, width, height) {
  const layout = new Map();
  if (agents.length === 0) return layout;

  const centerX = Math.max(width / 2, 80);
  const centerY = Math.max(height / 2, 80);
  const radiusX = Math.max(0, Math.min(width / 2 - 92, 300));
  const radiusY = Math.max(0, Math.min(height / 2 - 70, 220));

  if (agents.length === 1) {
    layout.set(agents[0].id, { x: centerX, y: centerY });
    return layout;
  }

  agents.forEach((agent, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / agents.length;
    layout.set(agent.id, {
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY,
    });
  });
  return layout;
}

function renderDetails(snapshot) {
  const agent = snapshot.agents.find((item) => item.id === state.selectedAgentId) ?? snapshot.agents[0];
  if (!agent) {
    els.details.querySelector("h2").textContent = "Agent";
    els.fields.replaceChildren();
    return;
  }

  els.details.querySelector("h2").textContent = agent.id;
  els.fields.replaceChildren(
    field("Persona", [agent.name, agent.role].filter(Boolean).join(" - ") || agent.personaId),
    field("Status", agent.status),
    field("Inbox", String(agent.inbox)),
    field("Turns", `completed ${agent.turns.completed}, failed ${agent.turns.failed}, total ${agent.turns.total}`),
    field("Timing", timingSummary(agent)),
    field("Activity", activityDetail(agent)),
    field("Latest", agent.activity.lastLabel || "none"),
    field("Tokens", tokenSummary(agent)),
    field("Waiting on", list(agent.waitingOn)),
    field("Waited on by", list(agent.waitedOnBy)),
  );
}

function field(name, value) {
  const frag = document.createDocumentFragment();
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  dd.textContent = value;
  frag.append(dt, dd);
  return frag;
}

function list(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

function nodeStats(agent) {
  const total = formatDuration(agent.turns.totalDurationMs);
  if (agent.turns.currentStartedAt) {
    return `${total} (${formatDuration(Date.now() - agent.turns.currentStartedAt)})`;
  }
  if (agent.waitingOn.length > 0) return `${total} - waits ${agent.waitingOn.length}`;
  return total;
}

function activitySummary(agent) {
  const activity = agent.activity;
  if (!activity) return "no session";
  return activity.lastLabel || "no activity";
}

function activityBars(agent, scale) {
  const activity = agent.activity ?? {};
  const values = [
    ["msg", activity.assistantMessages ?? 0],
    ["think", activity.thinkingBlocks ?? 0],
    ["tool", activity.toolCalls ?? 0],
  ];
  const current = agent.status === "running" ? currentActivityKind(activity.lastLabel) : null;
  const wrap = document.createElement("span");
  wrap.className = "activity-bars";
  wrap.title = activityBarsTitle(activity);
  const max = scale.activity ?? 1;
  for (const [kind, value] of values) {
    const bar = document.createElement("span");
    bar.className = `activity-bar ${kind}${current === kind ? " current" : ""}`;
    bar.style.setProperty("--w", `${barWidth(value, max)}%`);
    wrap.append(bar);
  }
  return wrap;
}

function activityBarsTitle(activity) {
  const latest = activity.lastLabel ? `; latest: ${activity.lastLabel}` : "";
  return `Assistant messages: ${activity.assistantMessages ?? 0}; thinking blocks: ${activity.thinkingBlocks ?? 0}; tool calls: ${activity.toolCalls ?? 0}${latest}`;
}

function graphActivityScale(agents) {
  return agents.reduce((scale, agent) => {
    const activity = agent.activity ?? {};
    const maxActivity = Math.max(
      activity.assistantMessages ?? 0,
      activity.thinkingBlocks ?? 0,
      activity.toolCalls ?? 0
    );
    scale.activity = Math.max(scale.activity, maxActivity);
    scale.tokens = Math.max(scale.tokens, activity.totalTokens ?? 0);
    return scale;
  }, { activity: 1, tokens: 1 });
}

function tokenBar(agent, scale) {
  const activity = agent.activity ?? {};
  const total = activity.totalTokens ?? 0;
  const wrap = document.createElement("span");
  wrap.className = "token-bar-wrap";
  wrap.title = tokenBarTitle(activity);

  const label = document.createElement("span");
  label.className = "token-label";
  label.textContent = tokenBarLabel(activity);

  const bar = document.createElement("span");
  bar.className = "activity-bar token";
  bar.style.setProperty("--w", `${barWidth(total, scale.tokens)}%`);

  wrap.append(bar, label);
  return wrap;
}

function tokenBarLabel(activity) {
  if (activity.totalCost) return `$${activity.totalCost.toFixed(3)}`;
  return `${compactNumber(activity.totalTokens ?? 0)} tok`;
}

function tokenBarTitle(activity) {
  const cost = activity.totalCost ? `; cost $${activity.totalCost.toFixed(4)}` : "";
  return `Tokens: in ${activity.inputTokens ?? 0}, out ${activity.outputTokens ?? 0}, total ${activity.totalTokens ?? 0}${cost}`;
}

function barWidth(value, max) {
  if (value <= 0) return 0;
  return Math.max(8, (value / Math.max(1, max)) * 100);
}

function currentActivityKind(label) {
  if (!label) return null;
  if (label.startsWith("tool")) return "tool";
  if (label === "thinking" || label === "turn prompt") return "think";
  if (label === "assistant text") return "msg";
  return null;
}

function timingSummary(agent) {
  const parts = [`total active ${formatDuration(agent.turns.totalDurationMs)}`];
  if (agent.turns.currentStartedAt) parts.unshift(`current ${formatDuration(Date.now() - agent.turns.currentStartedAt)}`);
  return parts.join(", ");
}

function activityDetail(agent) {
  const activity = agent.activity;
  if (!activity) return "none";
  return [
    `events ${activity.sessionEvents}`,
    `assistant ${activity.assistantMessages}`,
    `tools ${activity.toolCalls}/${activity.toolResults}`,
    `thinking ${activity.thinkingBlocks}`,
  ].join(", ");
}

function tokenSummary(agent) {
  const activity = agent.activity;
  if (!activity) return "none";
  const cost = activity.totalCost ? `, $${activity.totalCost.toFixed(4)}` : "";
  return `in ${activity.inputTokens}, out ${activity.outputTokens}, total ${activity.totalTokens}${cost}`;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function setConnection(text, mode) {
  els.connection.textContent = text;
  els.connection.className = `connection ${mode}`;
}

function svg(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

window.addEventListener("resize", () => {
  if (state.snapshot) renderGraph(state.snapshot);
});

refresh();
state.timer = window.setInterval(refresh, 1000);
