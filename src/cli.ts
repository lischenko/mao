#!/usr/bin/env node
import { Command, Option } from "commander";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { openDb } from "./db.js";
import { loadWorkflow, resolveWorkflowPath } from "./workflow.js";
import { runScheduler } from "./scheduler.js";
import { validateWorkflowModels } from "./runner.js";
import { HUMAN_AGENT_ID } from "./human.js";
import { buildProjectStatusSnapshot } from "./observability/read-model.js";
import { renderProjectStatusText } from "./observability/render-status.js";
import { startObservabilityServer } from "./observability/server.js";
import {
  inferProjectFromCwd,
  loadProjectConfig,
  saveProjectConfig,
  projectExists,
  projectDir,
  listProjects,
  type ProjectConfig,
} from "./project.js";

const program = new Command();

program
  .name("mao")
  .description("Minimal agent orchestration framework on top of pi")
  .addHelpText("after", `

Typical usage:
  $ mao run --project my-app --repo ~/src/my-app --workflow star-team --prompt 'Fix the startup crash'
  $ mao run --project my-feature --repo . --workflow stavros --prompt 'Implement the approved feature'

Workflow ids:
  star-team    All-star virtual team inspired by https://tarantsov.com/all-star-zoo/
  stavros      Architect/developer/reviewer loop inspired by https://www.stavros.io/posts/how-i-write-software-with-llms/
`)
  .version("2.0.0");

// ---------------------------------------------------------------------------
// Default command: create / send / run (all-in-one)
// ---------------------------------------------------------------------------

program
  .command("run", { isDefault: true })
  .description("Create project if needed, optionally send a task, then run the scheduler")
  .summary("create/prompt/run a project")
  .addOption(new Option("--project <name>", "Project name (defaults to inference from cwd)"))
  .addOption(new Option("--repo <path>", "Target repository path (required for new projects)"))
  .addOption(new Option("--workflow <id>", "Workflow id, e.g. star-team (required for new projects)"))
  .addOption(new Option("--prompt <text>", "Answer the workflow start prompt non-interactively"))
  .addOption(new Option("--model <spec>", "Override all persona models (and optionally thinking) for this run. Pi format: provider/model:thinking (e.g. claude-sonnet-4-6:low, anthropic/claude-opus-4-6:medium)"))
  .addOption(new Option("--parallel <n>", "Max concurrent agent turns (default: 8; use 1 for deterministic local testing).").argParser(Number))
  .addOption(new Option("--confirm", "Skip confirmation prompts (e.g. create missing repo directories)"))
  .addHelpText("after", `

Examples:
  $ mao run --project my-app --repo ~/src/my-app --workflow star-team --prompt 'Fix the startup crash'
  $ mao run --project my-app --repo ~/src/my-app --workflow stavros --prompt 'Plan and implement the login form'
  $ mao run --project my-app
`)
  .action(async (opts: { project?: string; repo?: string; workflow?: string; prompt?: string; model?: string; parallel?: number; confirm?: boolean }) => {

    // 1. Resolve project name
    const name = opts.project ?? inferProjectFromCwd();
    if (!name) {
      console.error(
        "Cannot infer project from current directory.\n" +
        "Either cd into a known project's repo, or pass --project <name>."
      );
      process.exit(1);
    }

    // 2. Create project if new
    let cfg: ProjectConfig;
    if (!projectExists(name)) {
      cfg = await createProject(name, opts.repo, opts.workflow, opts.confirm);
    } else {
      cfg = loadProjectConfig(name);
    }

    const workflow = loadWorkflow(cfg.workflow);
    const dir = projectDir(name);
    const db = openDb(dir, { recoverInterruptedTurns: true });

    // Ensure all personas + human are registered
    for (const persona of workflow.personas) db.upsertAgent(persona.id, persona.id);
    db.upsertAgent(HUMAN_AGENT_ID, HUMAN_AGENT_ID);

    const leadId = workflow.lead;
    const start = workflow.start ?? { to: leadId, ask: "What would you like to work on?" };
    const canStart = agentNeedsWork(db, start.to);

    if (canStart) {
      const answer = await getStartAnswer(start.ask, opts.prompt);
      if (answer) {
        if (start.instruction) db.insertMessage("framework", start.to, start.instruction, "framework");
        db.insertMessage(HUMAN_AGENT_ID, start.to, answer, "mail");
        db.setAgentStatus(start.to, "ready", Date.now());
      }
    }

    // 4. Validate models before starting the scheduler
    const modelError = await validateWorkflowModels(workflow, opts.model);
    if (modelError) {
      console.error(`\n[mao] ${modelError}`);
      process.exit(1);
    }

    // 5. Run
    console.log(`\n[mao] ${name}  workflow: ${workflow.name}  repo: ${cfg.repo}`);
    await runScheduler({
      projectDir: dir,
      repoDir: cfg.repo,
      workflow,
      db,
      modelOverride: opts.model,
      maxParallel: opts.parallel,

      onTurnStart: (agentId) => process.stdout.write(`\n[mao] ▶ ${agentId}  `),
      onTurnEnd: (_agentId, response) => {
        const preview = response.slice(0, 100).replace(/\n/g, " ");
        process.stdout.write(`${preview}${response.length > 100 ? "…" : ""}\n`);
      },
    });
    console.log("\n[mao] done.");
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Show agent statuses, inbox counts, and wait graph")
  .addOption(new Option("--project <name>", "Project name"))
  .addOption(new Option("--verbose", "Show detailed status fields"))
  .addOption(new Option("--json", "Print the shared status snapshot as JSON"))
  .action((opts: { project?: string; verbose?: boolean; json?: boolean }) => {
    const name = resolveProjectOrDie(opts.project);
    const cfg = loadProjectConfig(name);
    const workflow = loadWorkflow(cfg.workflow);
    const db = openDb(projectDir(name));
    const snapshot = buildProjectStatusSnapshot({ project: name, repo: cfg.repo, workflow, db });
    if (opts.json) console.log(JSON.stringify(snapshot, null, 2));
    else console.log(renderProjectStatusText(snapshot, { verbose: opts.verbose }));
  });

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

program
  .command("ui")
  .description("Serve the read-only observability API for one project")
  .addOption(new Option("--project <name>", "Project name"))
  .addOption(new Option("--host <host>", "Host to bind").default("127.0.0.1"))
  .addOption(new Option("--port <n>", "Port to listen on").default(4317).argParser(Number))
  .action(async (opts: { project?: string; host: string; port: number }) => {
    const name = resolveProjectOrDie(opts.project);
    const cfg = loadProjectConfig(name);
    const workflow = loadWorkflow(cfg.workflow);
    const db = openDb(projectDir(name));

    const { server, url } = await startObservabilityServer({
      project: name,
      repo: cfg.repo,
      workflow,
      db,
      host: opts.host,
      port: opts.port,
    });

    console.log(`[mao] observability API for '${name}' listening at ${url}`);
    console.log(`[mao] status: ${url}/api/status`);

    process.once("SIGINT", () => {
      server.close(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      server.close(() => process.exit(0));
    });
  });

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

program
  .command("reset")
  .description("Wipe all project state and start fresh")
  .addOption(new Option("--project <name>", "Project name"))
  .addOption(new Option("--confirm", "Skip confirmation prompt"))
  .action(async (opts: { project?: string; confirm?: boolean }) => {
    const name = resolveProjectOrDie(opts.project);
    const dir = projectDir(name);

    if (!opts.confirm) {
      const answer = await prompt(`Reset project '${name}'? Deletes all sessions and state. [y/N] `);
      if (answer.toLowerCase() !== "y") { console.log("Aborted."); return; }
    }

    // Remove state but keep config
    for (const sub of ["state.db", "sessions"]) {
      const p = `${dir}/${sub}`;
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    console.log(`[mao] Reset: removed state for project '${name}'.`);
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command("list")
  .description("List all known projects")
  .action(() => {
    const projects = listProjects();
    if (projects.length === 0) { console.log("No projects."); return; }
    for (const name of projects) {
      try {
        const cfg = loadProjectConfig(name);
        console.log(`  ${name.padEnd(20)} ${cfg.repo}`);
      } catch {
        console.log(`  ${name.padEnd(20)} (broken config)`);
      }
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProjectOrDie(explicitName?: string): string {
  const name = explicitName ?? inferProjectFromCwd();
  if (!name) {
    console.error("Cannot infer project. Pass --project <name> or cd into a known project's repo.");
    process.exit(1);
  }
  return name;
}

function agentNeedsWork(db: ReturnType<typeof openDb>, agentId: string): boolean {
  const agent = db.getAgent(agentId);
  if (!agent) return true;
  if (agent.status !== "idle") return false;
  return db.getUndeliveredMessages(agentId).length === 0;
}

async function getStartAnswer(question: string, promptArg?: string): Promise<string> {
  const answer = promptArg?.trim() || (await prompt(`${question.trim()} `)).trim();
  return answer;
}

async function createProject(
  name: string,
  repoArg?: string,
  workflowArg?: string,
  confirmFlag?: boolean
): Promise<ProjectConfig> {
  console.log(`Project '${name}' does not exist.`);
  const confirm = confirmFlag || (await prompt(`Create it? [Y/n] `)).toLowerCase() !== "n";
  if (!confirm) { console.log("Aborted."); process.exit(0); }

  const repoRaw = repoArg ?? await prompt("Repo path: ");
  const repo = resolve(repoRaw.trim() || process.cwd());
  if (!existsSync(repo)) {
    const mkdir = confirmFlag || (await prompt(`Repo path does not exist: ${repo}\nCreate it? [Y/n] `)).toLowerCase() !== "n";
    if (!mkdir) { console.log("Aborted."); process.exit(0); }
    mkdirSync(repo, { recursive: true });
    console.log(`[mao] Created repo directory: ${repo}`);
  }

  const workflowRaw = workflowArg ?? await prompt("Workflow id: ");
  const workflow = workflowRaw.trim();
  let workflowPath: string;
  try {
    workflowPath = resolveWorkflowPath(workflow);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!existsSync(workflowPath)) {
    console.error(`Workflow not found: ${workflowPath}`); process.exit(1);
  }

  const cfg: ProjectConfig = { name, repo, workflow };
  saveProjectConfig(cfg);
  console.log(`[mao] Project '${name}' created.`);
  return cfg;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

program.parse();
