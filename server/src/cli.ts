import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.ts";
import { formatTokens, formatUsd, summaryText } from "./stats.ts";
import { startServer } from "./web.ts";

/**
 * Usage: node dist/cli.js <stats | statusline | dashboard [--no-open] | serve | stop>
 */
const [cmd = "stats", ...opts] = process.argv.slice(2);
const port = readConfig().port;
const base = `http://127.0.0.1:${port}`;

async function running(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(500) });
    return (await r.text()) === "token-eco";
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const [prog, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  spawn(prog, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

switch (cmd) {
  case "stats":
    console.log(summaryText());
    break;

  case "statusline": {
    // Claude Code status line (stdin = session info, ignored): one short line.
    const { aggregate } = await import("./db.ts");
    const { toDollars } = await import("./config.ts");
    const d = aggregate("day"), t = aggregate("total");
    console.log(`token-eco ↓ today ${formatTokens(d.saved)} tok (${formatUsd(toDollars(d.saved))}) · total ${formatTokens(t.saved)} tok (${formatUsd(toDollars(t.saved))})`);
    break;
  }

  case "serve":
    await startServer(port);
    console.log(`token-eco: dashboard on ${base}`);
    break;

  case "dashboard": {
    if (!(await running())) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 30 && !(await running()); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await running())) {
      console.error(`Could not start the server on port ${port} (already in use? change "port" in ~/.token-eco/config.json).`);
      process.exit(1);
    }
    if (!opts.includes("--no-open")) openBrowser(base);
    console.log(`token-eco dashboard: ${base}  (stop: node cli.js stop)`);
    break;
  }

  case "stop":
    if (await running()) {
      await fetch(`${base}/api/stop`, { method: "POST" }).catch(() => {});
      console.log("Server stopped.");
    } else console.log("No server running.");
    break;

  default:
    console.error("Usage: cli.js <stats | statusline | dashboard [--no-open] | serve | stop>");
    process.exit(2);
}
