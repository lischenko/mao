import { els, statusColor, svg } from "./dom.js";
import { openPanels, state, PANEL_ORIGIN } from "./state.js";

export function renderGraph(snapshot, onTogglePanel) {
  const rect = els.graphWrap.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const layout = layoutAgents(snapshot.agents, width, height);

  els.graphSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.empty.classList.toggle("hidden", snapshot.agents.length > 0);
  els.graphSvg.replaceChildren(
    createArrowMarker(),
    renderGraphEdges(snapshot, layout),
    renderAgentNodes(snapshot.agents, layout, onTogglePanel),
  );
}

export function layoutAgents(agents, width, height) {
  const layout = new Map();
  if (agents.length === 0) return layout;

  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(20, Math.min(width / 2 - 22, 200));
  const ry = Math.max(20, Math.min(height / 2 - 32, 160));
  if (agents.length === 1) {
    layout.set(agents[0].id, { x: cx, y: cy });
    return layout;
  }

  agents.forEach((agent, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / agents.length;
    layout.set(agent.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  return layout;
}

export function renderConnectors(snapshot) {
  const wsRect = els.workspace.getBoundingClientRect();
  const graphRect = els.graphWrap.getBoundingClientRect();
  const layout = layoutAgents(snapshot.agents, graphRect.width, graphRect.height);
  const edgeX = graphRect.right - wsRect.left;
  const agentsById = new Map(snapshot.agents.map(agent => [agent.id, agent]));

  els.connectorOverlay.setAttribute("viewBox", `0 0 ${wsRect.width} ${wsRect.height}`);
  els.connectorOverlay.replaceChildren();

  const connectors = [...els.panelsContainer.querySelectorAll(".agent-panel")]
    .map(panel => connectorForPanel(panel, agentsById, layout, wsRect, graphRect))
    .filter(Boolean);
  if (connectors.length === 0) return;

  const laneSpacing = 8;
  const sorted = [...connectors].sort((a, b) => a.headerY - b.headerY);
  const lanes = new Map(sorted.map((connector, index) => [
    connector.agentId,
    edgeX - (connectors.length - index) * laneSpacing,
  ]));

  for (const connector of connectors) {
    const laneX = lanes.get(connector.agentId);
    const color = statusColor(connector.agent.status);
    const isUser = openPanels.get(connector.agentId) === PANEL_ORIGIN.USER;
    const exitX = laneX >= connector.nodeX ? connector.nodeX + 9 : connector.nodeX - 9;
    const pathAttrs = {
      d: `M ${exitX} ${connector.nodeY} H ${laneX} V ${connector.headerY} H ${edgeX}`,
      stroke: color,
      "stroke-width": "1.5",
      fill: "none",
      opacity: isUser ? "0.7" : "0.45",
    };
    if (!isUser) pathAttrs["stroke-dasharray"] = "4 4";
    els.connectorOverlay.append(
      svg("path", pathAttrs),
      svg("circle", { cx: edgeX, cy: connector.headerY, r: "3", fill: color, opacity: "0.7" }),
    );
  }
}

function createArrowMarker() {
  return svg("defs", {},
    svg("marker", {
      id: "arrow",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "5",
      markerHeight: "5",
      orient: "auto-start-reverse",
    }, svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--strong-line)" })),
  );
}

function renderGraphEdges(snapshot, layout) {
  const edges = svg("g");
  for (const edge of snapshot.communicationEdges ?? []) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to || edge.count <= edge.openCount) continue;
    edges.append(svg("line", {
      class: "history-edge",
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    }));
  }
  for (const edge of snapshot.waitEdges) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) continue;
    edges.append(svg("line", {
      class: "edge",
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      "marker-end": "url(#arrow)",
    }));
  }
  return edges;
}

function renderAgentNodes(agents, layout, onTogglePanel) {
  const nodes = svg("g");
  for (const agent of agents) {
    const point = layout.get(agent.id);
    if (!point) continue;
    nodes.append(renderAgentNode(agent, point, onTogglePanel));
  }
  return nodes;
}

function renderAgentNode(agent, point, onTogglePanel) {
  const node = svg("g", { style: { cursor: "pointer" } });
  node.addEventListener("click", () => onTogglePanel(agent.id));

  if (openPanels.has(agent.id)) {
    node.append(svg("circle", {
      cx: point.x,
      cy: point.y,
      r: "13",
      fill: "none",
      stroke: "#8c97a5",
      "stroke-width": "2",
    }));
  }
  node.append(
    svg("circle", { cx: point.x, cy: point.y, r: "9", fill: statusColor(agent.status) }),
    svg("text", {
      x: point.x,
      y: point.y + 20,
      "text-anchor": "middle",
      "font-size": "10",
      fill: "#69707a",
      textContent: agent.id.length > 14 ? `${agent.id.slice(0, 13)}...` : agent.id,
    }),
  );

  if (agent.inbox > 0) {
    node.append(
      svg("circle", { cx: point.x + 9, cy: point.y - 9, r: "5", fill: statusColor("running") }),
      svg("text", {
        x: point.x + 9,
        y: point.y - 6,
        "text-anchor": "middle",
        "font-size": "7",
        fill: "white",
        "font-weight": "bold",
        textContent: agent.inbox > 9 ? "9+" : String(agent.inbox),
      }),
    );
  }
  return node;
}

function connectorForPanel(panel, agentsById, layout, wsRect, graphRect) {
  const agentId = panel.dataset.agentId;
  const agent = agentsById.get(agentId);
  const point = layout.get(agentId);
  if (!agent || !point) return null;

  const header = panel.querySelector(".agent-header");
  const headerRect = (header ?? panel).getBoundingClientRect();
  return {
    agentId,
    agent,
    nodeX: (graphRect.left - wsRect.left) + point.x,
    nodeY: (graphRect.top - wsRect.top) + point.y,
    headerY: (headerRect.top - wsRect.top) + headerRect.height / 2,
  };
}
