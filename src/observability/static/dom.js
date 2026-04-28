export const els = {
  projectName: document.getElementById("project-name"),
  projectMeta: document.getElementById("project-meta"),
  connection: document.getElementById("connection-state"),
  statusCounts: document.getElementById("status-counts"),
  workspace: document.getElementById("workspace"),
  graphWrap: document.querySelector(".graph-wrap"),
  graphSvg: document.getElementById("graph-svg"),
  empty: document.getElementById("empty-state"),
  panelsContainer: document.getElementById("panels-container"),
  connectorOverlay: document.getElementById("connector-overlay"),
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs, true);
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}

export function svg(name, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  setAttrs(node, attrs, false);
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}

function setAttrs(node, attrs, useDomProperties) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "className" || key === "class") node.setAttribute("class", value);
    else if (key === "textContent") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (useDomProperties && key in node && !key.startsWith("aria-")) node[key] = value;
    else node.setAttribute(key, String(value));
  }
}

export function setConnection(text, mode) {
  els.connection.textContent = text;
  els.connection.className = `connection ${mode}`;
}

export function statusColor(status) {
  const varName = status === "error" ? "--failed" : `--${status}`;
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#8b949e";
}

export function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
