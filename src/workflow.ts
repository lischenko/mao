import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowConfig, PersonaConfig } from "./types.js";

const WORKFLOW_CONFIG_FILE = "config.json";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTIN_WORKFLOWS_DIR = join(PACKAGE_ROOT, "workflows");

interface PersonasManifestEntry {
  id: string;
  name: string;
  role: string;
  prompt_file: string;
  tools?: string[];
  model?: string;
  thinking_level?: PersonaConfig["thinkingLevel"];
}

interface PersonasManifest {
  personas: PersonasManifestEntry[];
}

interface WorkflowFile {
  id: string;
  name: string;
  description?: string;
  personas_manifest: string;
  lead: string;
  shared_prompt?: string;
  start?: {
    to: string;
    ask: string;
    instruction?: string;
  };
  agent_overrides?: Record<string, {
    tools?: string[];
    model?: string;
    thinking_level?: PersonaConfig["thinkingLevel"];
  }>;
}

export function loadWorkflow(workflowPath: string): WorkflowConfig {
  const absPath = resolveWorkflowPath(workflowPath);
  const raw = JSON.parse(readFileSync(absPath, "utf-8")) as WorkflowFile;
  const manifestPath = resolve(dirname(absPath), raw.personas_manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PersonasManifest;
  const manifestDir = dirname(manifestPath);
  const overrides = raw.agent_overrides ?? {};

  const personas: PersonaConfig[] = manifest.personas.map((entry) => {
    const ov = overrides[entry.id] ?? {};
    return {
      id: entry.id,
      name: entry.name,
      role: entry.role,
      promptFile: resolve(manifestDir, entry.prompt_file),
      tools: ov.tools ?? entry.tools,
      model: ov.model ?? entry.model,
      thinkingLevel: ov.thinking_level ?? entry.thinking_level,
    };
  });

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    personasManifest: manifestPath,
    personas,
    lead: raw.lead,
    sharedPromptFile: raw.shared_prompt ? resolve(dirname(absPath), raw.shared_prompt) : undefined,
    start: raw.start,
  };
}

export function resolveWorkflowPath(workflowPath: string): string {
  if (workflowPath.includes("/") || workflowPath.includes("\\")) {
    throw new Error(`Workflow must be a workflow id, not a path: ${workflowPath}`);
  }

  const workflowId = workflowPath.trim();
  if (!workflowId) {
    throw new Error("Workflow id is required.");
  }

  return join(BUILTIN_WORKFLOWS_DIR, workflowId, WORKFLOW_CONFIG_FILE);
}

export function getPersona(workflow: WorkflowConfig, id: string): PersonaConfig | null {
  return workflow.personas.find((p) => p.id === id) ?? null;
}
