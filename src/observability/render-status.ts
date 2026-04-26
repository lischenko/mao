import type { AgentStatusView, ProjectStatusSnapshot, WaitEdgeView } from "./read-model.js";

export function renderProjectStatusText(snapshot: ProjectStatusSnapshot, opts: { verbose?: boolean } = {}): string {
  return opts.verbose ? renderVerbose(snapshot) : renderCompact(snapshot);
}

function renderCompact(snapshot: ProjectStatusSnapshot): string {
  const lines: string[] = [
    `Project: ${snapshot.project}  workflow: ${snapshot.workflow.name} (${snapshot.workflow.id})  repo: ${snapshot.repo}`,
  ];

  if (snapshot.agents.length === 0) {
    lines.push("No agents registered.");
    return lines.join("\n");
  }

  lines.push("", "Agents:");
  for (const agent of snapshot.agents) {
    const waiting = agent.waitingOn.length > 0 ? `  waiting=[${agent.waitingOn.join(",")}]` : "";
    lines.push(
      `  ${agent.id.padEnd(12)} ${agent.status.padEnd(8)}  inbox=${agent.inbox}  turns=${agent.turns.completed}${waiting}`
    );
  }

  if (snapshot.waitEdges.length > 0) {
    lines.push("", "Wait graph:");
    for (const edge of snapshot.waitEdges) lines.push(`  ${edge.from} -> ${edge.to}`);
  }

  return lines.join("\n");
}

function renderVerbose(snapshot: ProjectStatusSnapshot): string {
  const lines: string[] = [
    `Project: ${snapshot.project}`,
    `Workflow: ${snapshot.workflow.name} (${snapshot.workflow.id})`,
    `Repo: ${snapshot.repo}`,
    "",
    "Summary:",
    `  agents=${snapshot.totals.agents}  ready=${snapshot.totals.ready}  running=${snapshot.totals.running}  waiting=${snapshot.totals.waiting}  idle=${snapshot.totals.idle}`,
    `  inbox=${snapshot.totals.inbox}  open_mail=${snapshot.totals.openMail}  completed_turns=${snapshot.totals.completedTurns}  failed_turns=${snapshot.totals.failedTurns}`,
  ];

  if (snapshot.agents.length === 0) {
    lines.push("", "No agents registered.");
    return lines.join("\n");
  }

  lines.push("", "Agents:");
  for (const agent of snapshot.agents) renderVerboseAgent(lines, agent);

  if (snapshot.waitEdges.length > 0) {
    lines.push("", "Open waits:");
    for (const edge of snapshot.waitEdges) renderVerboseEdge(lines, edge, snapshot.generatedAt);
  }

  return lines.join("\n");
}

function renderVerboseAgent(lines: string[], agent: AgentStatusView): void {
  lines.push(`  ${agent.id}`);
  if (agent.name || agent.role) {
    const parts = [agent.name, agent.role].filter(Boolean);
    lines.push(`    persona: ${parts.join(" - ")}`);
  }
  lines.push(`    status: ${agent.status}`);
  lines.push(`    inbox: ${agent.inbox}`);
  lines.push(
    `    turns: completed=${agent.turns.completed} failed=${agent.turns.failed} total=${agent.turns.total}`
  );
  lines.push(`    waiting_on: ${agent.waitingOn.length > 0 ? agent.waitingOn.join(", ") : "none"}`);
  lines.push(`    waited_on_by: ${agent.waitedOnBy.length > 0 ? agent.waitedOnBy.join(", ") : "none"}`);
}

function renderVerboseEdge(lines: string[], edge: WaitEdgeView, now: number): void {
  lines.push(`  ${edge.mailId}  ${edge.from} -> ${edge.to}  age=${formatAge(now - edge.createdAt)}`);
}

function formatAge(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
