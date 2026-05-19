import { defineTool } from "@mariozechner/pi-coding-agent";
import { MailCycleError } from "./db.js";
import type { Db } from "./db.js";
import type { AgentId, MailId, ToolSchemaOverride, TurnContext } from "./types.js";

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

export function createFrameworkTools(
  db: Db,
  ctx: TurnContext,
  toolSchemaOverrides: Record<string, ToolSchemaOverride> = {}
) {
  const sendMail = defineTool(withToolSchemaOverride({
    name: "sendMail",
    label: "Send Mail",
    description:
      "Send a message to another agent. All mail must be answered — the recipient is required " +
      "to call reply() to acknowledge and respond. You will block until the recipient replies. " +
      "You may call this multiple times in one turn to send to several agents in parallel; " +
      "call yield() when you are done issuing mail for this turn. " +
      "You will be woken when all recipients have replied. " +
      "If sending would create a circular dependency, the framework will refuse the message; " +
      "reply to existing pending mail in the cycle instead. " +
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
    execute: async (_id: string, params: { to?: string; content?: string; recipient?: string; message?: string }) => {
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

      let mailId: MailId;
      try {
        mailId = db.sendMail(ctx.agentId, to, content, ctx.turnId);
      } catch (err) {
        if (err instanceof MailCycleError) {
          const activeMail = ctx.activeMailId ? db.getOpenMail(ctx.activeMailId) : null;
          if (activeMail?.fromAgent === to) {
            return {
              content: [{
                type: "text" as const,
                text:
                  `Error: you are currently answering active mail ${activeMail.id} from ${to}. ` +
                  `Sending blocking mail back to that requester would create a circular dependency. ` +
                  `If this message is your answer, call reply({ content: ... }) with this content instead. ` +
                  `If you need clarification, reply with the question so ${to} can continue.`,
              }],
              details: { activeMailId: activeMail.id, requester: to },
            };
          }

          return {
            content: [{ type: "text" as const, text: err.message }],
            details: { cycle: err.chain },
          };
        }
        throw err;
      }
      ctx.pendingMail.push({ to: to as AgentId, mailId });

      return {
        content: [{ type: "text" as const, text: `Mail sent to ${to}. Call yield() when you are done sending mail.` }],
        details: {},
      };
    },
  }, toolSchemaOverrides.sendMail));

  const reply = defineTool(withToolSchemaOverride({
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
    execute: async (_id: string, params: { content: string }) => {
      if (typeof params.content !== "string") {
        return {
          content: [{ type: "text" as const, text: "Error: reply requires content string." }],
          details: {},
        };
      }
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
  }, toolSchemaOverrides.reply));

  const yieldTurn = defineTool(withToolSchemaOverride({
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

      ctx.yielded = true;

      return {
        content: [{ type: "text" as const, text: "Yielded control to the framework." }],
        details: {},
        terminate: true,
      };
    },
  }, toolSchemaOverrides.yield));

  return [sendMail, reply, yieldTurn];
}

function withToolSchemaOverride<T extends {
  description: string;
  parameters: Record<string, unknown>;
}>(
  definition: T,
  override: ToolSchemaOverride | undefined
): T {
  if (!override) return definition;

  return {
    ...definition,
    description: override.description
      ? `${definition.description}\n\nWorkflow-specific requirement: ${override.description}`
      : definition.description,
    parameters: override.schema,
  };
}
