import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionServices } from "@mariozechner/pi-coding-agent";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import type { PersonaConfig, TurnContext, AgentId, MailId, WorkflowConfig } from "./types.js";
import { createFrameworkTools } from "./tools.js";
import { HUMAN_AGENT_ID } from "./human.js";

export async function runAgentTurn(
  db: Db,
  projectDir: string,
  repoDir: string,
  agentId: AgentId,
  persona: PersonaConfig,
  workflow: WorkflowConfig,
  inboxText: string,
  turnId: string,
  modelOverride?: string
): Promise<string> {
  const sessionsDir = join(projectDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = join(sessionsDir, `${agentId}.jsonl`);
  const liveSessionFile = join(sessionsDir, `${agentId}.live.json`);
  rmSync(liveSessionFile, { force: true });

  // SessionManager backed by the agent's persistent session file.
  // cwd is repoDir so the agent's tools (read/bash/edit/write) operate on the repo.
  const sessionManager = SessionManager.open(sessionFile, sessionsDir, repoDir);

  const personaPrompt = readFileSync(persona.promptFile, "utf-8").trim();
  const systemPrompt = buildSystemPrompt(persona, personaPrompt, workflow);

  const services = await createMaoPiServices(repoDir, systemPrompt);
  assertNoPiServiceErrors(services);

  const { modelRegistry } = services;
  const modelSpec = modelOverride ? parseModelFromOverride(modelOverride) : persona.model;
  const model = resolvePersonaModel(modelSpec, persona.id, modelRegistry);
  const thinkingLevel = modelOverride
    ? parseThinkingFromOverride(modelOverride) ?? normalizeThinkingLevel(persona.thinkingLevel)
    : normalizeThinkingLevel(persona.thinkingLevel);

  // Turn context — tools close over this to record their side effects.
  const activeMail = db.getOpenMailTo(agentId);
  const ctx: TurnContext = {
    agentId,
    turnId,
    activeMailId: activeMail?.id ?? null,
    pendingMail: [],
    replied: false,
    replyContent: "",
    yielded: false,
  };

  const customTools = createFrameworkTools(db, ctx);
  const allowedTools = getAllowedTools(persona);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    tools: allowedTools,
    customTools,
    model,
    thinkingLevel,
  });
  const label = `${agentId} (${persona.name})`;
  process.stdout.write(
    `\n  [${label}] session: ${session.model?.provider ?? "?"}/${session.model?.id ?? "?"} thinking=${session.thinkingLevel}`
  );

  // Track whether the last assistant message was an error so we can fail the
  // turn instead of silently retrying forever (e.g. rate-limit / quota errors).
  let lastModelError: string | null = null;
  const streamingToolArgs = new Map<number, { name: string; chars: number; lastPrinted: number }>();

  session.subscribe((event: any) => {
    if (event.type === "message_end") {
      const msg = event.message;
      if (msg?.stopReason === "error" && msg?.errorMessage) {
        lastModelError = msg.errorMessage;
      }
    }
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame?.type === "text_delta" || ame?.type === "thinking_delta") {
        process.stdout.write(ame.delta);
      } else if (ame?.type === "toolcall_delta") {
        printToolCallDeltaProgress(label, streamingToolArgs, event);
      }
      writeLiveSessionUpdate(liveSessionFile, agentId, turnId, event);
    } else if (event.type === "compaction_start") {
      process.stdout.write(`\n  [${label}] compaction: ${event.reason ?? "unknown"} `);
    } else if (event.type === "compaction_end") {
      const status = event.errorMessage ? `error=${event.errorMessage}` : event.aborted ? "aborted" : "done";
      process.stdout.write(`\n  [${label}] compaction: ${status} `);
    } else if (event.type === "tool_execution_start") {
      const input = formatToolInput(event.args);
      process.stdout.write(`\n  [${label}] ${event.toolName ?? "tool"}${input ? ` ${input}` : ""} `);
    } else if (event.type === "tool_execution_update") {
      process.stdout.write(".");
    } else if (event.type === "tool_execution_end") {
      const text = formatToolResultText(event.result);
      if (text) process.stdout.write(`${text}\n`);
      else process.stdout.write("\n");
    }
  });

  const turnPrompt = buildTurnPrompt(db, agentId, persona, workflow, inboxText, allowedTools, activeMail ?? null);
  process.stdout.write(`\n  [${label}] waiting for response... `);
  try {
    await session.prompt(turnPrompt);
  } finally {
    rmSync(liveSessionFile, { force: true });
  }

  const response = session.getLastAssistantText() ?? "";

  // If the model returned an API error and the agent didn't call any
  // framework tools (reply / sendMail / yield), throw so the scheduler
  // can enforce retry limits instead of looping forever.
  if (lastModelError && !ctx.replied && ctx.pendingMail.length === 0 && !ctx.yielded) {
    throw new Error(`Model error for ${agentId}: ${lastModelError}`);
  }

  // If the model did not reply to active mail and did not delegate, wake it
  // with an explicit framework prod. Natural-language answers do not close mail;
  // the agent must call reply() so the waiting sender can resume.
  if (!ctx.replied && ctx.activeMailId && ctx.pendingMail.length === 0) {
    const mail = db.getOpenMail(ctx.activeMailId);
    if (mail) {
      db.insertMessage("framework", agentId, formatMissingReplyProd(mail.id, mail.fromAgent), "framework", mail.id, turnId);
    }
  }

  // Plain assistant text is visible in the terminal/session log, but it does
  // not affect orchestration. Require an explicit tool call so workflows do not
  // silently finish when an agent meant to send mail.
  if (!ctx.activeMailId && ctx.pendingMail.length === 0 && !ctx.replied && !ctx.yielded) {
    db.insertMessage("framework", agentId, formatMissingActionProd(), "framework", undefined, turnId);
  }

  // If the agent replied via the reply() tool, close the active mail and deliver the reply.
  if (ctx.replied && ctx.activeMailId) {
    db.replyToMail(ctx.activeMailId, agentId, ctx.replyContent, turnId);
  }

  return response;
}

function printToolCallDeltaProgress(
  label: string,
  streamingToolArgs: Map<number, { name: string; chars: number; lastPrinted: number }>,
  event: any,
): void {
  const ame = event.assistantMessageEvent;
  const index = typeof ame?.contentIndex === "number" ? ame.contentIndex : -1;
  const block = index >= 0 ? event.message?.content?.[index] : undefined;
  const name = block?.name ?? "tool";
  const state = streamingToolArgs.get(index) ?? { name, chars: 0, lastPrinted: 0 };
  state.name = name;
  state.chars += typeof ame?.delta === "string" ? ame.delta.length : 0;

  const shouldPrint = state.lastPrinted === 0 || state.chars - state.lastPrinted >= 2048;
  if (shouldPrint) {
    process.stdout.write(`\n  [${label}] ${state.name} args streaming ${formatCompactNumber(state.chars)} chars `);
    state.lastPrinted = state.chars;
  }
  streamingToolArgs.set(index, state);
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function writeLiveSessionUpdate(liveSessionFile: string, agentId: AgentId, turnId: string, event: any): void {
  if (!event.message) return;
  const payload = {
    agentId,
    turnId,
    timestamp: new Date().toISOString(),
    message: event.message,
    assistantMessageEvent: event.assistantMessageEvent,
  };
  try {
    const tempFile = `${liveSessionFile}.tmp`;
    writeFileSync(tempFile, JSON.stringify(payload));
    renameSync(tempFile, liveSessionFile);
  } catch {
    // Observability must not interfere with agent execution.
  }
}

function formatMissingActionProd(): string {
  return (
    `## Framework Reminder: Action Required\n\n` +
    `Your previous turn ended without calling a framework tool.\n\n` +
    `Ordinary assistant text is only a local transcript entry; it is not delivered to another agent ` +
    `and it does not change scheduler state. If you intended to ask or tell another agent something, ` +
    `call \`sendMail({ to: ..., content: ... })\`. If you are genuinely done for now, call \`yield()\`.`
  );
}

function formatMissingReplyProd(mailId: MailId, senderId: AgentId): string {
  return (
    `## Framework Reminder: Reply Required\n\n` +
    `You still have active mail \`${mailId}\` from \`${senderId}\`.\n\n` +
    `Your previous turn ended without calling \`reply()\` and without sending mail to another agent. ` +
    `The sender remains blocked until you call \`reply({ content: ... })\` with your answer. ` +
    `Do that now, or send mail if you genuinely need another agent's input first.`
  );
}

/** Non-throwing variant used by validateWorkflowModels. */
function resolveModelSpec(spec: string, modelRegistry: ModelRegistry): any | undefined {
  const explicit = parseModelSpec(spec);
  return explicit
    ? modelRegistry.find(explicit.provider, explicit.modelId)
    : modelRegistry.getAll().find((candidate) => candidate.id === spec);
}

function resolvePersonaModel(modelSpec: string | undefined, personaId: string, modelRegistry: ModelRegistry): any | undefined {
  if (!modelSpec) return undefined;

  const explicit = parseModelSpec(modelSpec);
  const model = explicit
    ? modelRegistry.find(explicit.provider, explicit.modelId)
    : modelRegistry.getAll().find((candidate) => candidate.id === modelSpec);

  if (!model) {
    throw new Error(`Unknown model for persona ${personaId}: ${modelSpec}`);
  }
  return model;
}

/**
 * Validate that every persona in the workflow has: a resolvable model, and auth
 * credentials for the model's provider. Returns null if all are fine, otherwise
 * a user-facing error message.
 */
export async function validateWorkflowModels(
  workflow: WorkflowConfig,
  repoDir: string,
  modelOverride?: string
): Promise<string | null> {
  const services = await createMaoPiServices(repoDir);
  const serviceError = formatPiServiceErrors(services);
  if (serviceError) return serviceError;

  const { modelRegistry } = services;
  const allModels = modelRegistry.getAll();

  if (allModels.length === 0) {
    return (
      "No models are configured in pi.\n" +
      'Run `pi` and use /login to connect a provider (OpenAI, Anthropic, etc.) or set an API key.\n' +
      "See: https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md"
    );
  }

  const missingAuth: Set<string> = new Set();

  for (const persona of workflow.personas) {
    // Mirror the resolution logic in runAgentTurn
    const modelSpec = modelOverride
      ? parseModelFromOverride(modelOverride)
      : persona.model;

    if (!modelSpec) {
      // Persona has no model — pi picks its default. Check if *any* model has auth.
      const anyAuth = allModels.some((m) => modelRegistry.hasConfiguredAuth(m));
      if (!anyAuth) {
        return (
          "No API key or OAuth token configured for any provider in pi.\n" +
          'Run `pi` and use /login to connect a provider, or set an API key.\n' +
          "See: https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md"
        );
      }
      continue;
    }

    const model = resolveModelSpec(modelSpec, modelRegistry);
    if (!model) {
      return `Unknown model "${modelSpec}" for persona "${persona.id}". Check the workflow config or your pi model setup.`;
    }

    if (!modelRegistry.hasConfiguredAuth(model)) {
      missingAuth.add(model.provider);
    }
  }

  if (missingAuth.size > 0) {
    const providers = [...missingAuth].map((p) => `"${p}"`).join(", ");
    const s = missingAuth.size > 1 ? "s" : "";
    return (
      `No credentials found for provider${s} ${providers}.\n` +
      'Run `pi` and use /login to connect a provider, or set an API key.\n' +
      "See: https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md"
    );
  }

  return null;
}

async function createMaoPiServices(repoDir: string, systemPrompt?: string): Promise<AgentSessionServices> {
  return createAgentSessionServices({
    cwd: repoDir,
    resourceLoaderOptions: {
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: systemPrompt ? () => systemPrompt : undefined,
    },
  });
}

function assertNoPiServiceErrors(services: AgentSessionServices): void {
  const error = formatPiServiceErrors(services);
  if (error) throw new Error(error);
}

function formatPiServiceErrors(services: AgentSessionServices): string | null {
  const diagnostics = services.diagnostics
    .filter((diagnostic) => diagnostic.type === "error")
    .map((diagnostic) => diagnostic.message);
  const extensionErrors = services.resourceLoader.getExtensions().errors.map(
    ({ path, error }: { path: string; error: unknown }) => `Failed to load extension "${path}": ${error}`
  );
  const errors = [...diagnostics, ...extensionErrors];
  return errors.length > 0 ? errors.join("\n") : null;
}

function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
  const slash = spec.indexOf("/");
  if (slash > 0) return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };

  const colon = spec.indexOf(":");
  if (colon > 0) return { provider: spec.slice(0, colon), modelId: spec.slice(colon + 1) };

  return null;
}

function normalizeThinkingLevel(level: PersonaConfig["thinkingLevel"] | "off" | "minimal" | "xhigh"): any | undefined {
  if (!level) return undefined;
  if (level === "none") return "off";
  if (level === "max") return "high";
  return level;
}

function buildSystemPrompt(
  persona: PersonaConfig,
  personaPrompt: string,
  workflow: WorkflowConfig
): string {
  const sharedPrompt = loadSharedPrompt(workflow);

  return (
    `You are ${persona.name}.\n` +
    `Your routing/persona id is \`${persona.id}\`.\n` +
    `Your role is ${persona.role}.\n\n` +
    `${personaPrompt}\n\n` +
    `---\n\n` +
    `## Framework Instructions\n\n` +
    `You operate inside a multi-agent orchestration framework. You communicate exclusively ` +
    `via framework-delivered turn context, inbox messages, and framework tools.\n\n` +
    `- \`sendMail()\`: Send a message to another agent. All mail must be answered — the recipient ` +
    `is required to call \`reply()\`. You block until the recipient replies. You may send multiple ` +
    `mails in one turn; call \`yield()\` when done.\n` +
    `- \`reply()\`: Respond to a mail that was sent to you. Your turn ends after replying.\n` +
    `- \`yield()\`: End your turn without side effects.\n\n` +
    `Call \`yield()\` when you have no more work to do in the current turn and do not need to ` +
    `send mail or reply.\n\n` +
    `Known routing ids are: ${formatKnownRecipients(workflow)}. Use routing ids exactly as written; ` +
    `unknown recipients are errors, not aliases to resolve.\n\n` +
    `${sharedPrompt ? `${sharedPrompt}\n` : ""}`
  );
}

function buildTurnPrompt(
  db: Db,
  agentId: AgentId,
  persona: PersonaConfig,
  workflow: WorkflowConfig,
  inboxText: string,
  allowedTools: string[],
  activeMail: { id: MailId; task: string } | null
): string {
  const lines: string[] = [
    "## Framework Turn Context",
    "",
    `You are ${persona.name}.`,
    `Runtime agent id: \`${agentId}\`.`,
    `Routing/persona id: \`${persona.id}\`.`,
    `Role: ${persona.role}.`,
    `Workflow: ${workflow.name} (\`${workflow.id}\`).`,
    `Workflow lead id: \`${workflow.lead}\`.`,
    `Active mail id: ${activeMail ? `\`${activeMail.id}\`` : "none"}.`,
    `Available tools this turn: ${allowedTools.map((tool) => `\`${tool}\``).join(", ")}.`,
    `Known recipients: ${formatKnownRecipients(workflow)}.`,
    "",
    "Process the inbox below. If there is no inbox, process your current framework state and take the next appropriate action.",
    "",
  ];

  if (inboxText.trim()) {
    lines.push(inboxText.trim());
  } else {
    lines.push("## Inbox", "", "No new messages.");
  }

  if (activeMail) {
    lines.push(
      "",
      "## Active Mail Task",
      "",
      "You must eventually answer this active mail by calling `reply({ content: ... })`. Plain assistant text does not close the mail or unblock the sender.",
      "",
      activeMail.task
    );
  }

  const waitEdges = db.getWaitEdges(agentId);
  if (waitEdges.length > 0) {
    lines.push(
      "",
      "## Current Waits",
      "",
      ...waitEdges.map((edge) => `- Waiting for \`${edge.waitingFor}\` on mail \`${edge.mailId}\`.`)
    );
  }

  return lines.join("\n");
}

function formatKnownRecipients(workflow: WorkflowConfig): string {
  const personaIds = workflow.personas.map((persona) => `\`${persona.id}\``);
  return [...personaIds, `\`${HUMAN_AGENT_ID}\``].join(", ");
}

function loadSharedPrompt(workflow: WorkflowConfig): string {
  if (!workflow.sharedPromptFile) return "";
  return readFileSync(workflow.sharedPromptFile, "utf-8").trim();
}

function getAllowedTools(persona: PersonaConfig): string[] {
  return persona.tools ?? ["read", "sendMail", "reply", "yield"];
}

function formatToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const payload = result as {
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
    message?: string;
  };

  const text = payload.text ?? payload.message ?? payload.content?.find((item) => item.type === "text")?.text ?? "";
  return text ? ` ${text}` : "";
}

function formatToolInput(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }

  const input = args as Record<string, unknown>;
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatToolValue(value)}`);

  return entries.length > 0 ? `(${entries.join(" ")})` : "";
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "none", "max"]);

/**
 * Parse pi's model:thinking pattern (same format as pi's --model CLI flag).
 * "claude-sonnet-4-6:low" → { model: "claude-sonnet-4-6", thinking: "low" }
 * "anthropic/claude-sonnet-4-6:medium" → { model: "anthropic/claude-sonnet-4-6", thinking: "medium" }
 * "claude-opus-4-6" → { model: "claude-opus-4-6", thinking: undefined }
 */
function parseModelOverride(raw: string): { model: string; thinking?: string } {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1) return { model: raw };
  const prefix = raw.slice(0, lastColon);
  const suffix = raw.slice(lastColon + 1);
  if (VALID_THINKING_LEVELS.has(suffix)) {
    return { model: prefix, thinking: suffix };
  }
  return { model: raw };
}

function parseThinkingFromOverride(raw: string): string | undefined {
  return parseModelOverride(raw).thinking;
}

function parseModelFromOverride(raw: string): string {
  return parseModelOverride(raw).model;
}
