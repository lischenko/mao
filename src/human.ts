import { createInterface } from "node:readline";
import type { Db } from "./db.js";
import type { AgentId } from "./types.js";

export const HUMAN_AGENT_ID: AgentId = "human";

/**
 * Run a human "turn": print the inbox to stdout and block on stdin for a reply.
 * Returns the human's response text.
 */
export async function runHumanTurn(
  db: Db,
  inboxText: string
): Promise<string> {
  if (inboxText) {
    console.log("\n" + "─".repeat(60));
    console.log(inboxText);
    console.log("─".repeat(60));
  }

  process.stdout.write("\n[human] > ");

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines: string[] = [];

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      lines.push(line);
    });
    rl.on("close", () => {
      resolve(lines.join("\n").trim());
    });
    // Also allow single-line response from TTY (press enter to submit)
    if (process.stdin.isTTY) {
      rl.once("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
    }
  });
}

/**
 * Close any open mail to the human agent by routing the human's reply.
 */
export function routeHumanReply(db: Db, replyContent: string): void {
  const mail = db.getOpenMailTo(HUMAN_AGENT_ID);
  if (!mail) return;
  db.replyToMail(mail.id, HUMAN_AGENT_ID, replyContent);
}
