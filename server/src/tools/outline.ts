import { readFile } from "node:fs/promises";
import { nativeReadChars, absolutePath, splitLines, truncate, type ToolResult } from "../types.ts";
import { declarations, isImport, computeMask, importedModule, profileFor } from "../languages/engine.ts";

/**
 * Structural outline of a file, whatever the language: declarations with line numbers,
 * without bodies, imports summarised on one line. Engine and profiles: src/languages/.
 */

const MAX_DECLARATIONS = 400;

/** Cleans a signature: drops the trailing opening brace and normalises indentation. */
function signature(line: string): string {
  return truncate(line.replace(/\t/g, "  ").replace(/\s*\{\s*$/, "").trimEnd(), 160);
}

export interface OutlineArgs {
  file: string;
}

export async function outline(args: OutlineArgs, cwd?: string): Promise<ToolResult> {
  const content = await readFile(absolutePath(args.file, cwd), "utf8");
  const lines = splitLines(content);
  const profile = profileFor(args.file, content.slice(0, 8000));
  const mask = computeMask(lines, profile);
  const width = String(lines.length).length;

  // Imports (including Go `import ( … )` blocks), summarised on one line.
  const imports: string[] = [];
  const importLines = new Set<number>();
  let firstImport = 0;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || !isImport(lines[i], profile)) continue;
    if (!firstImport) firstImport = i + 1;
    importLines.add(i);
    if (/\(\s*$/.test(lines[i])) {
      for (i++; i < lines.length && !/^\s*\)/.test(lines[i]); i++) {
        importLines.add(i);
        if (lines[i].trim() && !lines[i].trim().startsWith("//")) imports.push(importedModule(lines[i]));
      }
      importLines.add(i);
    } else imports.push(importedModule(lines[i]));
  }

  const decls = declarations(lines, profile, mask).filter((i) => !importLines.has(i));
  const output = decls.slice(0, MAX_DECLARATIONS).map((i) => `${String(i + 1).padStart(width)}|${signature(lines[i])}`);
  if (decls.length > MAX_DECLARATIONS) output.push(`[+${decls.length - MAX_DECLARATIONS} declarations: refine with search]`);

  const header = `${args.file} (${lines.length} lines, ${profile.id}) — outline`;
  const importsLine = imports.length
    ? `imports (${imports.length}, from l.${firstImport}): ${truncate([...new Set(imports)].join(", "), 600)}`
    : "";
  const body = output.length ? output.join("\n") : "(no declarations detected — use read_range)";
  return {
    text: [header, importsLine, body].filter(Boolean).join("\n"),
    nativeChars: nativeReadChars(lines),
    details: { file: args.file, language: profile.id, declarations: decls.length },
  };
}
