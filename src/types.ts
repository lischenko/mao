export type AgentId = string;
export type MessageId = string;
export type MailId = string;

export type AgentStatus = "idle" | "ready" | "running" | "waiting";
export type MessageType = "mail" | "reply" | "framework";

export interface AgentRecord {
  id: AgentId;
  personaId: string;
  status: AgentStatus;
  readyAt: number | null;
  createdAt: number;
}

export interface Message {
  id: MessageId;
  fromAgent: AgentId;
  toAgent: AgentId;
  content: string;
  type: MessageType;
  createdAt: number;
  deliveredAt: number | null;
  mailId: MailId | null;
  producedByTurnId: string | null;
}

export interface OpenMail {
  id: MailId;
  fromAgent: AgentId;
  toAgent: AgentId;
  task: string;
  createdAt: number;
  repliedAt: number | null;
}

export interface WaitEdge {
  agentId: AgentId;
  waitingFor: AgentId;
  mailId: MailId;
  createdAt: number;
}

export interface PersonaConfig {
  id: string;
  name: string;
  role: string;
  promptFile: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: "none" | "low" | "medium" | "high" | "max";
}

export interface WorkflowConfig {
  id: string;
  name: string;
  description?: string;
  personasManifest: string;
  personas: PersonaConfig[];
  lead: AgentId;
  sharedPromptFile?: string;
  start?: {
    to: AgentId;
    ask: string;
    instruction?: string;
  };
}

export interface TurnContext {
  agentId: AgentId;
  turnId: string;
  activeMailId: MailId | null;
  pendingMail: Array<{ to: AgentId; mailId: MailId }>;
  replied: boolean;
  replyContent: string;
}
