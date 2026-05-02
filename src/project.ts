import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface ProjectConfig {
  name: string;
  repo: string;
  workflow: string;
}

export function projectsRoot(): string {
  return projectRoots()[0];
}

export function projectRoots(cwd: string = process.cwd()): string[] {
  const roots: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    const localRoot = join(dir, ".mao");
    if (existsSync(localRoot)) roots.push(localRoot);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const homeRoot = join(homedir(), ".mao");
  if (!roots.includes(homeRoot)) roots.push(homeRoot);
  return roots;
}

export function projectDir(name: string): string {
  for (const root of projectRoots()) {
    const dir = join(root, name);
    if (existsSync(join(dir, "config.json"))) return dir;
  }
  return join(projectsRoot(), name);
}

export function projectConfigPath(name: string): string {
  return join(projectDir(name), "config.json");
}

export function loadProjectConfig(name: string): ProjectConfig {
  const path = projectConfigPath(name);
  if (!existsSync(path)) throw new Error(`Project '${name}' not found (looked in ${path})`);
  return JSON.parse(readFileSync(path, "utf-8")) as ProjectConfig;
}

export function saveProjectConfig(cfg: ProjectConfig): void {
  const dir = projectDir(cfg.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(projectConfigPath(cfg.name), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function projectExists(name: string): boolean {
  return existsSync(projectConfigPath(name));
}

export function listProjects(): string[] {
  const names = new Set<string>();
  for (const root of projectRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, "config.json"))) {
        names.add(entry.name);
      }
    }
  }
  return [...names];
}

/**
 * Infer the project name from the current working directory.
 *
 * Rules (in order):
 * 1. cwd IS a project dir (./.mao/<name> or ~/.mao/<name>)
 * 2. cwd is the repo or inside the repo of a known project
 *
 * Returns null if no match.
 */
export function inferProjectFromCwd(cwd: string = process.cwd()): string | null {
  const absCwd = resolve(cwd);
  // Rule 1: cwd is directly a project dir
  for (const root of projectRoots(cwd)) {
    if (absCwd.startsWith(root + "/")) {
      const rel = absCwd.slice(root.length + 1).split("/")[0];
      if (rel && existsSync(join(root, rel, "config.json"))) return rel;
    }
  }

  // Rule 2: cwd is inside a known project's repo
  for (const name of listProjects()) {
    try {
      const cfg = loadProjectConfig(name);
      const repoAbs = resolve(cfg.repo);
      if (absCwd === repoAbs || absCwd.startsWith(repoAbs + "/")) return name;
    } catch {
      // skip broken configs
    }
  }

  return null;
}
