// Role: Primitive DOM factories. Creates elements, caches key element refs, formatting helpers.
// Boundary: No state, no events, no data—only element creation and string formatting.

export const els = {
  projectName: document.getElementById("project-name"),
  projectMeta: document.getElementById("project-meta"),
  connection: document.getElementById("connection-state"),
  statusCounts: document.getElementById("status-counts"),
  workspace: document.getElementById("workspace"),
  panelsContainer: document.getElementById("panels-container"),
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs, true);
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}

function setAttrs(node, attrs, useDomProperties) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "className" || key === "class") node.setAttribute("class", value);
    else if (key === "textContent") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") setStyle(node, value);
    else if (useDomProperties && key in node && !key.startsWith("aria-")) node[key] = value;
    else node.setAttribute(key, String(value));
  }
}

function setStyle(node, style) {
  for (const [key, value] of Object.entries(style)) {
    if (key.startsWith("--")) node.style.setProperty(key, value);
    else node.style[key] = value;
  }
}

export function setConnection(text, mode) {
  els.connection.textContent = text;
  els.connection.className = `connection ${mode}`;
}

export function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function notice(text) {
  return el("p", { className: "sev-notice", textContent: text });
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
