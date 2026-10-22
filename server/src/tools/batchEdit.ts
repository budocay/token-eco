import { readFile, writeFile } from "node:fs/promises";
import { absolutePath, splitLines, type ToolResult } from "../types.ts";

/**
 * Several exact replacements in one call, all or nothing: everything is validated
 * in memory before writing a single file. Minimal answer (line numbers).
 *
 * Native reference (conservative estimate): for each edit, the native Edit returns
 * a snippet of the modified file (~5 numbered lines around). NOT counted:
 * the round trips avoided and the prior full read the native Edit requires.
 */

export interface EditOp {
  file: string;
  oldText: string;
  newText: string;
  all?: boolean;
}

export interface BatchEditArgs {
  edits: EditOp[];
}

const NATIVE_CONTEXT = 5;
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

function findAll(text: string, pattern: string): number[] {
  const positions: number[] = [];
  for (let i = text.indexOf(pattern); i !== -1; i = text.indexOf(pattern, i + pattern.length)) positions.push(i);
  return positions;
}

export async function batchEdit(args: BatchEditArgs, cwd?: string): Promise<ToolResult> {
  const contents = new Map<string, string>();
  const reports = new Map<string, string[]>();
  const errors: string[] = [];
  let nativeChars = 0, nb = 0;

  for (const [k, e] of args.edits.entries()) {
    const filePath = absolutePath(e.file, cwd);
    if (!contents.has(filePath)) {
      try { contents.set(filePath, await readFile(filePath, "utf8")); }
      catch (err) { errors.push(`#${k + 1} ${e.file} : ${(err as Error).message}`); continue; }
    }
    const text = contents.get(filePath)!;
    if (!e.oldText) { errors.push(`#${k + 1} ${e.file}: empty old_string`); continue; }
    const pos = findAll(text, e.oldText);
    if (!pos.length) { errors.push(`#${k + 1} ${e.file}: text not found`); continue; }
    if (pos.length > 1 && !e.all) {
      errors.push(`#${k + 1} ${e.file}: ${pos.length} occurrences (l.${pos.slice(0, 5).map((p) => lineOf(text, p)).join(", ")}) — add context or replace_all=true`);
      continue;
    }
    const linesBefore = pos.map((p) => lineOf(text, p));
    const newContent = e.all ? text.split(e.oldText).join(e.newText) : text.replace(e.oldText, () => e.newText);
    contents.set(filePath, newContent);
    nb += pos.length;

    // Snippet the native Edit would have returned for each occurrence.
    const lines = splitLines(newContent);
    const height = e.newText.split("\n").length + 2 * NATIVE_CONTEXT;
    for (const l of linesBefore) {
      const from = Math.max(0, l - 1 - NATIVE_CONTEXT);
      for (const line of lines.slice(from, from + height)) nativeChars += line.length + 7;
    }
    const delta = e.newText.split("\n").length - e.oldText.split("\n").length;
    const r = reports.get(e.file) ?? [];
    r.push(`l.${linesBefore.join(",")}${delta ? ` (${delta > 0 ? "+" : ""}${delta} l.)` : ""}`);
    reports.set(e.file, r);
  }

  if (errors.length) {
    throw new Error(`nothing written (${errors.length} error(s)):\n${errors.join("\n")}`);
  }
  await Promise.all([...contents].map(([filePath, text]) => writeFile(filePath, text)));

  const lines = [...reports].map(([f, r]) => `  ${f}: ${r.join("; ")}`);
  return {
    text: `OK: ${nb} replacement(s) in ${reports.size} file(s)\n${lines.join("\n")}`,
    nativeChars,
    details: { edits: args.edits.length, remplacements: nb, files: reports.size },
  };
}
