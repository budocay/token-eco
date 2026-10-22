/**
 * `node run.js '<command>'`: runs the command in the shell, compacts its output
 * (stdout + stderr in arrival order), returns the SAME exit code and records
 * the real savings (raw vs compact output). Used by the Bash hook (rewrite).
 */
import { spawn } from "node:child_process";
import { compact, family } from "./compact.ts";
import { record } from "./db.ts";
import { estimateTokens } from "./tokens.ts";

/** Claude Code's native Bash truncates output around 30,000 characters: honest reference. */
const NATIVE_CAP = 30_000;
const MAX_CAPTURE = 20_000_000;

const command = process.argv[2] ?? "";
const t0 = Date.now();
const child = spawn(process.env.SHELL || "/bin/bash", ["-c", command], { stdio: ["inherit", "pipe", "pipe"] });
const chunks: Buffer[] = [];
let size = 0;
const capture = (b: Buffer) => { if (size < MAX_CAPTURE) { chunks.push(b); size += b.length; } };
child.stdout.on("data", capture);
child.stderr.on("data", capture);
child.on("error", (e) => { process.stderr.write(`token-eco run: ${e.message}\n`); process.exit(127); });
child.on("close", (code, signal) => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const output = code ?? (signal ? 128 : 1);
  let text = raw;
  try { text = compact(command, raw, output); } catch { /* when in doubt: raw output */ }
  if (text.length >= raw.length) text = raw.replace(/\s+$/, "");
  process.stdout.write(text + (text ? "\n" : ""));
  try {
    record({
      project: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      tool: "bash",
      returnedTokens: estimateTokens(text),
      nativeTokens: estimateTokens(raw.slice(0, NATIVE_CAP)),
      durationMs: Date.now() - t0,
      details: { family: family(command), code: output, command: command.slice(0, 120) },
    });
  } catch { /* measuring must never get in the way */ }
  process.exit(output);
});
