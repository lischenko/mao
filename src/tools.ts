import { defineTool } from "@mariozechner/pi-coding-agent";
import type { Db } from "./db.js";
import type { AgentId, TurnContext } from "./types.js";

const strParam = (description: string) => ({ type: "string" as const, description });

function resolveAgentId(db: Db, id: string): AgentId | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (db.getAgent(trimmed)) return trimmed;
  return null;
}

function unknownRecipientResult(toolName: string, rawTo: string) {
  const requested = rawTo.trim() || rawTo;
  return {
    content: [{ type: "text" as const, text: `Error: ${toolName} recipient '${requested}' is not a known agent.` }],
    details: {},
  };
}

export function createFrameworkTools(db: Db, ctx: TurnContext) {
  const sendMail = defineTool({
    name: "sendMail",
    label: "Send Mail",
    description:
      "Send a message to another agent. All mail must be answered — the recipient is required " +
      "to call reply() to acknowledge and respond. You will block until the recipient replies. " +
      "You may call this multiple times in one turn to send to several agents in parallel; " +
      "call yield() when you are done issuing mail for this turn. " +
      "You will be woken when all recipients have replied. " +
      "Use this for task assignments, status updates, questions — any communication.",
    parameters: {
      type: "object" as const,
      properties: {
        to: strParam("Persona ID of the recipient agent"),
        content: strParam("Message body"),
        recipient: strParam("Alias for to"),
        message: strParam("Alias for content"),
      },
      required: [],
    },
    execute: async (_id, params: { to?: string; content?: string; recipient?: string; message?: string }) => {
      const rawTo = params.to ?? params.recipient;
      const content = params.content ?? params.message;
      if (!rawTo || !content) {
        return {
          content: [{ type: "text" as const, text: "Error: sendMail requires to/content." }],
          details: {},
        };
      }

      const to = resolveAgentId(db, rawTo);
      if (!to) return unknownRecipientResult("sendMail", rawTo);

      const mailId = db.sendMail(ctx.agentId, to, content);
      ctx.pendingMail.push({ to: to as AgentId, mailId });

      return {
        content: [{ type: "text" as const, text: `Mail sent to ${to}. Call yield() when you are done sending mail.` }],
        details: {},
      };
    },
  });

  const reply = defineTool({
    name: "reply",
    label: "Reply",
    description:
      "Send your final reply to the agent who sent you mail. " +
      "Call this when your work is complete. Your turn ends after this.",
    parameters: {
      type: "object" as const,
      properties: {
        content: strParam("Your reply — the result of your work"),
      },
      required: ["content"],
    },
    execute: async (_id, params: { content: string }) => {
      if (!ctx.activeMailId) {
        return {
          content: [{ type: "text" as const, text: "Error: no active mail to reply to." }],
          details: {},
        };
      }
      if (ctx.replied) {
        return {
          content: [{ type: "text" as const, text: "Error: you have already replied to this mail." }],
          details: {},
        };
      }

      ctx.replied = true;
      ctx.replyContent = params.content;

      return {
        content: [{ type: "text" as const, text: "Reply recorded. Your turn will end." }],
        details: {},
        terminate: true,
      };
    },
  });

  const yieldTurn = defineTool({
    name: "yield",
    label: "Yield",
    description:
      "Yield control back to the framework without sending mail or replying. " +
      "Call this when you have no further action to take in this turn.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    execute: async () => {
      if (ctx.activeMailId && !ctx.replied && ctx.pendingMail.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: active mail ${ctx.activeMailId} still requires a reply. ` +
              "Call reply({ content: ... }) to answer it, or sendMail() if you need another agent's input first.",
          }],
          details: {},
        };
      }

      return {
        content: [{ type: "text" as const, text: "Yielded control to the framework." }],
        details: {},
        terminate: true,
      };
    },
  });

  return [sendMail, reply, yieldTurn];
}
