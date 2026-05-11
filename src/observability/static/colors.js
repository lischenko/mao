// Role: Stable agent color assignment shared across observability components.
// Boundary: No DOM, no rendering, no data fetching.

const AGENT_COLORS = [
  "#3366cc", "#dc3912", "#ff9900", "#109618", "#990099",
  "#0099c6", "#dd4477", "#66aa00", "#b82e2e", "#316395",
];

const agentColorMap = new Map();
let colorNext = 0;

export function assignAgentColors(agents) {
  for (const agent of agents) {
    getAgentColor(agent.agentId ?? agent.id);
  }
}

export function getAgentColor(agentId) {
  if (!agentId) return "#8b949e";
  if (!agentColorMap.has(agentId)) {
    agentColorMap.set(agentId, AGENT_COLORS[colorNext % AGENT_COLORS.length]);
    colorNext++;
  }
  return agentColorMap.get(agentId);
}
