import type { AgentId } from "./types.js";
import type { Db } from "./db.js";
import type { Message, WorkflowConfig } from "./types.js";
import { getPersona } from "./workflow.js";

export function formatInbox(messages: Message[], agentId: AgentId, workflow?: WorkflowConfig): string {
  if (messages.length === 0) return "";

  const lines: string[] = ["## Inbox\n"];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const ts = new Date(msg.createdAt).toISOString().slice(11, 16);
    const typeLabel = msg.type === "reply" ? "reply" : msg.type === "framework" ? "FRAMEWORK" : "mail";
    const from = formatAgent(msg.fromAgent, workflow);
    const mailIdLabel = msg.mailId ? ` | mail: ${msg.mailId}` : "";
    lines.push(`### [${i + 1}] From: ${from} | ${ts} | ${typeLabel}${mailIdLabel}`);
    lines.push(msg.content);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Collect all undelivered messages for an agent and format them as inbox text.
 * The scheduler marks them delivered only after a successful turn, so Ctrl-C or
 * model failures do not lose mail.
 */
export function readInbox(db: Db, agentId: AgentId, workflow?: WorkflowConfig): { inboxText: string; messages: Message[] } {
  const messages = db.getUndeliveredMessages(agentId);
  if (messages.length === 0) return { inboxText: "", messages: [] };

  const inboxText = formatInbox(messages, agentId, workflow);
  return { inboxText, messages };
}

export function markInboxDelivered(db: Db, messages: Message[]): void {
  db.markMessagesDelivered(messages.map((m) => m.id));
}

function formatAgent(agentId: AgentId, workflow?: WorkflowConfig): string {
  if (agentId === "user") return "User";
  if (agentId === "framework") return "Framework";
  if (agentId === "human") return "Human";

  const persona = workflow ? getPersona(workflow, agentId) : null;
  if (!persona) return agentId;
  return `${persona.name} (${persona.role}; id: ${persona.id})`;
}
