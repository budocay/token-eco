/**
 * Canonical project of a directory: the main git repository it belongs to, so that sub-folders
 * (apps/web, services/api…) and git worktrees (repo-F-016, repo-fix…) all count as one project.
 * Outside git (or if the folder no longer exists): the folder itself.
 * Cached in memory and in <dataDir>/projects.json (hooks are short-lived processes).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "./config.ts";

let cache: Record<string, string> | null = null;
const cacheFile = () => join(dataDir(), "projects.json");

function load(): Record<string, string> {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(cacheFile(), "utf8")); } catch { cache = {}; }
  return cache!;
}

function git(dir: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

function compute(dir: string): string {
  if (!existsSync(dir)) return dir;
  const common = git(dir, "--git-common-dir");
  if (common) {
    const abs = isAbsolute(common) ? common : resolve(dir, common);
    if (basename(abs) === ".git") return dirname(abs);
  }
  return git(dir, "--show-toplevel") ?? dir;
}

export function projectRoot(dir: string): string {
  const d = resolve(dir);
  const c = load();
  if (c[d]) return c[d];
  const root = compute(d);
  // Only cache what git confirmed (a missing folder may be a worktree that comes back).
  if (existsSync(d)) {
    c[d] = root;
    try { writeFileSync(cacheFile(), JSON.stringify(c)); } catch { /* cache is optional */ }
  }
  return root;
}

/** Short display name of a project path. */
export const shortName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
