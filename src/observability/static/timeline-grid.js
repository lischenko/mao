// Role: Grid-based timeline component. Turns are squares on an epoch lattice.
// Each epoch boundary = a sorted, deduped set of all turn start/end times.
// Overlap = shared column. Edges are orthogonal forward-time connectors.
// API: createTimeline(container, {onAgentClick, onTurnClick}) → {render(turnsData), highlightTurn}

import { el } from "./dom.js";
import { assignAgentColors, getAgentColor } from "./colors.js";

const GRID = {
  rowHeight: 22,
  colWidth: 18,
  cellSize: 16,
  laneLeft: 80,
};

// ── Component ──────────────────────────────────────────────────────

export function createTimeline(container, { onAgentClick, onTurnClick } = {}) {
  let data = null;
  let highlightedTurnId = null;

  function render() {
    if (!data || data.agents.length === 0) {
      container.replaceChildren(el("div", { className: "tl-empty", textContent: "No turns yet" }));
      return;
    }

    const model = buildGridModel(data);

    const wrapper = el("div", {
      className: "tlg",
      style: {
        "--tlg-row-height": `${GRID.rowHeight}px`,
        "--tlg-col-width": `${GRID.colWidth}px`,
        "--tlg-cell-size": `${GRID.cellSize}px`,
      },
    });
    const svgWidth = Math.max(model.laneLeft, model.colCount * GRID.colWidth + model.laneLeft);

    if (model.edges.length > 0) {
      const svg = drawEdges(model.edges, model.turnColumns, data.agents.length, svgWidth, model.laneLeft);
      wrapper.append(svg);
    }

    // Rows
    for (let rowIdx = 0; rowIdx < data.agents.length; rowIdx++) {
      const a = data.agents[rowIdx];
      const color = getAgentColor(a.agentId);
      const squares = model.squaresByRow.get(rowIdx) ?? [];

      const row = el("div", { className: "tlg-row" });
      const label = el("span", {
        className: "tlg-agent-label",
        textContent: a.agentId,
        title: `${a.agentId} · ${a.turns.length} turns`,
      });
      label.addEventListener("click", () => onAgentClick?.(a.agentId));
      row.append(label);

      const lane = el("div", { className: "tlg-lane" });
      for (const sq of squares) {
        const cell = el("div", {
          className: "tlg-cell",
          dataset: { turnId: sq.turnId, agentId: a.agentId, col: sq.col },
          style: {
            left: `${sq.col * GRID.colWidth}px`,
            background: color,
          },
          title: `${a.agentId} · Turn ${sq.turnId.split("-").pop()} · epoch ${sq.col}`,
        });
        if (highlightedTurnId === sq.turnId) cell.classList.add("highlight");
        if (sq.running) cell.classList.add("running");
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          onTurnClick?.(a.agentId, sq.turnId);
        });
        lane.append(cell);
      }

      row.append(lane);
      wrapper.append(row);
    }

    // Now indicator — highlight the last epoch column
    if (model.colCount > 0) {
      const nowLine = el("div", {
        className: "tlg-now",
        style: { left: `${model.laneLeft + (model.colCount - 1) * GRID.colWidth}px` },
      });
      wrapper.append(nowLine);
    }

    container.replaceChildren(wrapper);
  }

  const instance = {
    render(nextData) {
      data = nextData;
      render();
    },
    highlightTurn(turnId) {
      highlightedTurnId = turnId;
      for (const cell of container.querySelectorAll(".tlg-cell")) {
        cell.classList.toggle("highlight", cell.dataset.turnId === turnId);
      }
    },
  };

  return instance;
}

function buildGridModel(data) {
  const now = new Date().toISOString();
  assignAgentColors(data.agents);
  const allEpochs = collectEpochs(data, now);
  const { oldToNew, colCount } = buildColumnMap(data, allEpochs, now);
  const { turnColumns, squaresByRow } = buildTurnColumns(data, allEpochs, oldToNew);
  return {
    laneLeft: GRID.laneLeft,
    colCount,
    turnColumns,
    squaresByRow,
    edges: data.edges ?? [],
  };
}

function collectEpochs(data, now) {
  const timestamps = new Set([now]);
  for (const agent of data.agents) {
    for (const turn of agent.turns) {
      if (turn.startTime) timestamps.add(turn.startTime);
      if (turn.endTime) timestamps.add(turn.endTime);
    }
  }
  return [...timestamps].sort();
}

function buildColumnMap(data, allEpochs, now) {
  const oldToNew = new Map([[0, 0]]);
  let col = 0;

  for (let i = 0; i < allEpochs.length - 1; i++) {
    const eStart = allEpochs[i];
    const eEnd = allEpochs[i + 1];
    if (data.agents.some(a => a.turns.some(t => coversEpoch(t, eStart, eEnd, now)))) col++;
    oldToNew.set(i + 1, col);
  }

  return { oldToNew, colCount: col };
}

function coversEpoch(turn, eStart, eEnd, now) {
  if (!turn.startTime) return false;
  return turn.startTime <= eStart && (turn.endTime ?? now) >= eEnd;
}

function buildTurnColumns(data, allEpochs, oldToNew) {
  const turnColumns = new Map();
  const squaresByRow = new Map();

  for (let rowIdx = 0; rowIdx < data.agents.length; rowIdx++) {
    const agent = data.agents[rowIdx];
    const squares = [];
    for (const turn of agent.turns) {
      if (!turn.startTime) continue;
      const tEnd = turn.endTime ?? allEpochs[allEpochs.length - 1];
      const oldStart = allEpochs.findIndex(e => e >= turn.startTime);
      const oldEnd = allEpochs.findIndex(e => e >= tEnd);
      if (oldStart < 0 || oldEnd < 0) continue;

      const startCol = oldToNew.get(oldStart);
      const endCol = oldToNew.get(oldEnd);
      if (startCol === endCol) continue;

      turnColumns.set(turn.turnId, { startCol, endCol, rowIdx });
      for (let c = startCol; c < endCol; c++) {
        squares.push({
          col: c,
          turnId: turn.turnId,
          running: turn.status === "running" && c === endCol - 1,
        });
      }
    }
    squaresByRow.set(rowIdx, squares);
  }

  return { turnColumns, squaresByRow };
}

// ── Edges ───────────────────────────────────────────────────────────

const EDGE_STYLES = {
  mail:  { stroke: "#20242a", width: 1,   markerFill: "#20242a", markerSize: 6, z: 1 },
  reply: { stroke: "#8b949e", width: 0.8, markerFill: "#8b949e", markerSize: 5, z: 0 },
};

function drawEdges(edges, turnColumns, numRows, svgWidth, laneLeft) {
  const ns = "http://www.w3.org/2000/svg";
  const svgHeight = numRows * GRID.rowHeight;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "tlg-arrows");
  svg.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  svg.style.height = `${svgHeight}px`;
  svg.style.width = `${svgWidth}px`;

  const defs = document.createElementNS(ns, "defs");
  const markerIds = {};
  for (const [key, s] of Object.entries(EDGE_STYLES)) {
    const id = `tlg-m-${key}`;
    markerIds[key] = id;
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("markerWidth", s.markerSize);
    marker.setAttribute("markerHeight", s.markerSize);
    marker.setAttribute("refX", "0");
    marker.setAttribute("refY", s.markerSize / 2);
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    const tip = document.createElementNS(ns, "path");
    tip.setAttribute("d", `M 0 0 L ${s.markerSize} ${s.markerSize / 2} L 0 ${s.markerSize} z`);
    tip.setAttribute("fill", s.markerFill);
    marker.append(tip);
    defs.append(marker);
  }
  svg.append(defs);

  for (const e of [...edges].sort((a, b) => edgeStyle(a).z - edgeStyle(b).z)) {
    const style = edgeStyle(e);
    const from = turnColumns.get(e.fromTurnId);
    const to = turnColumns.get(e.toTurnId);
    if (!from || !to) continue;

    const fromLeftX = laneLeft + from.endCol * GRID.colWidth - GRID.cellSize;
    const fromX = fromLeftX + GRID.cellSize - GRID.cellSize / 4;
    const fromY = from.rowIdx * GRID.rowHeight + GRID.rowHeight / 2;
    const toX = laneLeft + to.startCol * GRID.colWidth;
    const toY = to.rowIdx * GRID.rowHeight + GRID.rowHeight / 2;

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${fromX} ${fromY} V ${toY} H ${toX}`);
    path.setAttribute("stroke", style.stroke);
    path.setAttribute("stroke-width", style.width);
    path.setAttribute("fill", "none");
    path.setAttribute("marker-end", `url(#${markerIds[e.type]})`);
    svg.append(path);
  }

  return svg;
}

function edgeStyle(edge) {
  return EDGE_STYLES[edge.type] ?? EDGE_STYLES.mail;
}
