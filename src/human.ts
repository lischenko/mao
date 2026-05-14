import { createInterface } from "node:readline";
import type { Db } from "./db.js";
import type { AgentId, Message } from "./types.js";

export const HUMAN_AGENT_ID: AgentId = "human";

export type HumanTurnResult =
  | { action: "reply"; content: string }
  | { action: "sendMail"; to: AgentId; content: string }
  | { action: "yield" }
  | { action: "wait" };

/**
 * Run a human "turn": print inbox/active mail and map stdin into the same
 * protocol actions agents use. Empty input only yields when there is no active
 * mail; active mail stays open.
 */
export async function runHumanTurn(
  db: Db,
  inboxText: string,
  defaultRecipient: AgentId
): Promise<HumanTurnResult> {
  const activeMail = db.getOpenMailTo(HUMAN_AGENT_ID);

  if (inboxText) {
    console.log("\n" + "-".repeat(60));
    console.log(inboxText);
    console.log("-".repeat(60));
  } else if (activeMail) {
    console.log("\n" + "-".repeat(60));
    console.log(`Active mail from ${activeMail.fromAgent}:`);
    console.log(activeMail.task);
    console.log("-".repeat(60));
  }

  const prompt = activeMail
    ? `[human replying to ${activeMail.fromAgent}] > `
    : `[human -> ${defaultRecipient}] > `;
  process.stdout.write(`\n${prompt}`);

  const content = await readHumanInput();

  if (content) {
    if (activeMail) return { action: "reply", content };
    return { action: "sendMail", to: defaultRecipient, content };
  }

  if (activeMail) return { action: "wait" };
  return { action: "yield" };
}

export function routeHumanTurn(db: Db, result: HumanTurnResult, turnId?: string): string {
  if (result.action === "reply") {
    const mail = db.getOpenMailTo(HUMAN_AGENT_ID);
    if (!mail) return "";
    db.replyToMail(mail.id, HUMAN_AGENT_ID, result.content, turnId);
    return result.content;
  }

  if (result.action === "sendMail") {
    db.sendMail(HUMAN_AGENT_ID, result.to, result.content, turnId);
    return result.content;
  }

  return "";
}

export function defaultHumanRecipient(messages: Message[], fallback: AgentId): AgentId {
  for (const message of [...messages].reverse()) {
    if (message.fromAgent !== "framework" && message.fromAgent !== HUMAN_AGENT_ID) {
      return message.fromAgent;
    }
  }
  return fallback;
}

function readHumanInput(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines: string[] = [];

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      lines.push(line);
    });
    rl.on("close", () => {
      resolve(lines.join("\n").trim());
    });
    // Also allow single-line response from TTY (press enter to submit).
    if (process.stdin.isTTY) {
      rl.once("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
    }
  });
}
