import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentId,
  AgentRecord,
  AgentStatus,
  MailId,
  Message,
  MessageId,
  MessageType,
  OpenMail,
  WaitEdge,
} from "./types.js";

export interface OpenDbOptions {
  recoverInterruptedTurns?: boolean;
}

export interface TurnStats {
  completed: number;
  failed: number;
  running: number;
  total: number;
  currentStartedAt: number | null;
  lastStartedAt: number | null;
  lastEndedAt: number | null;
  totalDurationMs: number;
}

export interface CommunicationEdge {
  from: AgentId;
  to: AgentId;
  count: number;
  lastAt: number;
}

export function openDb(projectDir: string, opts: OpenDbOptions = {}): Db {
  mkdirSync(projectDir, { recursive: true });
  const raw = new DatabaseSync(join(projectDir, "state.db"));
  raw.exec("PRAGMA journal_mode=WAL");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      ready_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mail (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      replied_at INTEGER,
      expects_reply INTEGER NOT NULL DEFAULT 0,
      produced_by_turn_id TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS turn_inbox (
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (turn_id, message_id)
    );
  `);
  if (opts.recoverInterruptedTurns) {
    recoverInterruptedTurns(raw);
  }
  return new Db(raw);
}

function recoverInterruptedTurns(raw: DatabaseSync): void {
  // Failed turns may have appended a Pi prompt without completing. Redeliver
  // mail acknowledged by those turns and close the turn records. This must run
  // only from `mao run`, not from status/debug DB opens, because it mutates state.
  const openTurns = raw.prepare(
    `SELECT id, agent_id, started_at
     FROM turns AS open_turn
     WHERE ended_at IS NULL
       AND started_at > COALESCE((
         SELECT MAX(started_at)
         FROM turns AS completed_turn
         WHERE completed_turn.agent_id = open_turn.agent_id
           AND completed_turn.status = 'completed'
       ), 0)`
  ).all() as Array<{ id: string; agent_id: AgentId; started_at: number }>;
  for (const turn of openTurns) {
    raw.prepare(
      `UPDATE mail
       SET delivered_at = NULL
       WHERE to_agent = ?
         AND delivered_at IS NOT NULL
         AND delivered_at >= ?`
    ).run(turn.agent_id, turn.started_at);
  }
  const now = Date.now();
  raw.prepare("UPDATE turns SET ended_at = ?, status = 'failed' WHERE ended_at IS NULL").run(now);

  raw.exec(`UPDATE agents SET status = 'idle' WHERE status = 'running'`);
}

export class Db {
  constructor(readonly raw: DatabaseSync) {}

  // --- agents ---

  upsertAgent(id: AgentId, personaId: string, status: AgentStatus = "idle"): void {
    const now = Date.now();
    this.raw.prepare(
      `INSERT INTO agents (id, persona_id, status, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(id, personaId, status, now);
  }

  getAgent(id: AgentId): AgentRecord | null {
    const row = this.raw.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    return row ? rowToAgent(row) : null;
  }

  getAllAgents(): AgentRecord[] {
    return (this.raw.prepare("SELECT * FROM agents").all() as any[]).map(rowToAgent);
  }

  setAgentStatus(id: AgentId, status: AgentStatus, readyAt?: number): void {
    this.raw.prepare(
      "UPDATE agents SET status = ?, ready_at = ? WHERE id = ?"
    ).run(status, readyAt ?? null, id);
  }

  getReadyAgents(): AgentRecord[] {
    return (
      this.raw.prepare(
        "SELECT * FROM agents WHERE status = 'ready' ORDER BY ready_at ASC"
      ).all() as any[]
    ).map(rowToAgent);
  }

  // --- mail ---

  insertMessage(
    fromAgent: AgentId,
    toAgent: AgentId,
    content: string,
    type: MessageType,
    mailId?: MailId,
    producedByTurnId?: string
  ): MessageId {
    const id = randomUUID();
    const now = Date.now();
    this.raw.prepare(
      `INSERT INTO mail (id, parent_id, from_agent, to_agent, content, type, created_at, produced_by_turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, mailId ?? null, fromAgent, toAgent, content, type, now, producedByTurnId ?? null);
    return id;
  }

  getUndeliveredMessages(toAgent: AgentId): Message[] {
    return (
      this.raw.prepare(
        "SELECT * FROM mail WHERE to_agent = ? AND delivered_at IS NULL ORDER BY created_at ASC"
      ).all(toAgent) as any[]
    ).map(rowToMessage);
  }

  markMessagesDelivered(ids: MessageId[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.raw.prepare(
      `UPDATE mail SET delivered_at = ? WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  }

  hasUndeliveredMessages(toAgent: AgentId): boolean {
    const row = this.raw.prepare(
      "SELECT COUNT(*) as cnt FROM mail WHERE to_agent = ? AND delivered_at IS NULL"
    ).get(toAgent) as any;
    return row.cnt > 0;
  }

  // --- open mail ---

  openMail(fromAgent: AgentId, toAgent: AgentId, task: string, producedByTurnId?: string): MailId {
    const id = randomUUID();
    const now = Date.now();
    this.raw.prepare(
      `INSERT INTO mail (id, from_agent, to_agent, content, type, created_at, expects_reply, produced_by_turn_id)
       VALUES (?, ?, ?, ?, 'mail', ?, 1, ?)`
    ).run(id, fromAgent, toAgent, task, now, producedByTurnId ?? null);
    return id;
  }

  sendMail(fromAgent: AgentId, toAgent: AgentId, content: string, producedByTurnId?: string): MailId {
    const mailId = this.openMail(fromAgent, toAgent, content, producedByTurnId);
    this.setAgentStatus(toAgent, "ready", Date.now());
    return mailId;
  }

  getOpenMail(id: MailId): OpenMail | null {
    const row = this.raw.prepare("SELECT * FROM mail WHERE id = ? AND expects_reply = 1").get(id) as any;
    return row ? rowToOpenMail(row) : null;
  }

  getOpenMailTo(agentId: AgentId): OpenMail | null {
    const row = this.raw.prepare(
      `SELECT * FROM mail
       WHERE to_agent = ? AND expects_reply = 1 AND replied_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
    ).get(agentId) as any;
    return row ? rowToOpenMail(row) : null;
  }

  closeMail(mailId: MailId): void {
    this.raw.prepare(
      "UPDATE mail SET replied_at = ? WHERE id = ?"
    ).run(Date.now(), mailId);
  }

  replyToMail(mailId: MailId, fromAgent: AgentId, content: string, producedByTurnId?: string): void {
    const mail = this.getOpenMail(mailId);
    if (!mail) return;

    this.closeMail(mailId);
    this.insertMessage(fromAgent, mail.fromAgent, content, "reply", mailId, producedByTurnId);

    const waiter = this.getAgent(mail.fromAgent);
    if (waiter && this.getWaitEdges(mail.fromAgent).length === 0) {
      this.setAgentStatus(mail.fromAgent, "ready", Date.now());
    }
  }

  // --- derived wait graph ---

  getWaitEdges(agentId: AgentId): WaitEdge[] {
    return (
      this.raw.prepare(
      `SELECT from_agent AS agent_id, to_agent AS waiting_for, id AS mail_id
              , created_at
         FROM mail
         WHERE from_agent = ? AND expects_reply = 1 AND replied_at IS NULL`
      ).all(agentId) as any[]
    ).map(rowToWait);
  }

  getAllWaitEdges(): WaitEdge[] {
    return (
      this.raw.prepare(
      `SELECT from_agent AS agent_id, to_agent AS waiting_for, id AS mail_id
              , created_at
         FROM mail
         WHERE expects_reply = 1 AND replied_at IS NULL`
      ).all() as any[]
    ).map(rowToWait);
  }

  getCommunicationEdges(): CommunicationEdge[] {
    return (this.raw.prepare(
      `SELECT from_agent AS from_id, to_agent AS to_id, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM mail
       WHERE type = 'mail'
         AND from_agent IN (SELECT id FROM agents)
         AND to_agent IN (SELECT id FROM agents)
       GROUP BY from_agent, to_agent
       ORDER BY last_at DESC`
    ).all() as Array<{ from_id: AgentId; to_id: AgentId; count: number; last_at: number }>)
      .map((row) => ({
        from: row.from_id,
        to: row.to_id,
        count: row.count,
        lastAt: row.last_at,
      }));
  }

  // --- turns ---

  startTurn(agentId: AgentId): string {
    const id = randomUUID();
    this.raw.prepare(
      "INSERT INTO turns (id, agent_id, started_at) VALUES (?, ?, ?)"
    ).run(id, agentId, Date.now());
    return id;
  }

  recordTurnInbox(turnId: string, messageIds: MessageId[]): void {
    if (messageIds.length === 0) return;
    const stmt = this.raw.prepare(
      "INSERT OR IGNORE INTO turn_inbox (turn_id, message_id) VALUES (?, ?)"
    );
    for (const messageId of messageIds) stmt.run(turnId, messageId);
  }

  endTurn(turnId: string, status: "completed" | "failed"): void {
    this.raw.prepare(
      "UPDATE turns SET ended_at = ?, status = ? WHERE id = ?"
    ).run(Date.now(), status, turnId);
  }

  getTurnCount(agentId: AgentId): number {
    const row = this.raw.prepare(
      "SELECT COUNT(*) as cnt FROM turns WHERE agent_id = ? AND status = 'completed'"
    ).get(agentId) as any;
    return row.cnt;
  }

  getTurnStats(agentId: AgentId): TurnStats {
    const rows = this.raw.prepare(
      `SELECT status, started_at, ended_at
       FROM turns
       WHERE agent_id = ?`
    ).all(agentId) as Array<{ status: string | null; started_at: number; ended_at: number | null }>;
    const stats: TurnStats = {
      completed: 0,
      failed: 0,
      running: 0,
      total: 0,
      currentStartedAt: null,
      lastStartedAt: null,
      lastEndedAt: null,
      totalDurationMs: 0,
    };
    const now = Date.now();
    for (const row of rows) {
      if (row.status === "completed") stats.completed++;
      else if (row.status === "failed") stats.failed++;
      if (row.ended_at === null) {
        stats.running++;
        stats.currentStartedAt = stats.currentStartedAt === null
          ? row.started_at
          : Math.min(stats.currentStartedAt, row.started_at);
        stats.totalDurationMs += now - row.started_at;
      } else {
        stats.totalDurationMs += row.ended_at - row.started_at;
        stats.lastEndedAt = stats.lastEndedAt === null ? row.ended_at : Math.max(stats.lastEndedAt, row.ended_at);
      }
      stats.lastStartedAt = stats.lastStartedAt === null ? row.started_at : Math.max(stats.lastStartedAt, row.started_at);
      stats.total++;
    }
    return stats;
  }
}

function rowToAgent(row: any): AgentRecord {
  return {
    id: row.id,
    personaId: row.persona_id,
    status: row.status as AgentStatus,
    readyAt: row.ready_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    content: row.content,
    type: row.type as MessageType,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    mailId: row.parent_id ?? (row.expects_reply ? row.id : null),
    producedByTurnId: row.produced_by_turn_id ?? null,
  };
}

function rowToOpenMail(row: any): OpenMail {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    task: row.content,
    createdAt: row.created_at,
    repliedAt: row.replied_at ?? null,
  };
}

function rowToWait(row: any): WaitEdge {
  return {
    agentId: row.agent_id,
    waitingFor: row.waiting_for,
    mailId: row.mail_id,
    createdAt: row.created_at,
  };
}
