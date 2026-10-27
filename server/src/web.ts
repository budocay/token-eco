import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { statistics } from "./stats.ts";
import { insights } from "./insights.ts";

/** Works from src/ (tests) and from dist/ (bundle): server/public/index.html. */
const HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));

const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** Bound to 127.0.0.1 only; rejects foreign Host headers (DNS rebinding). */
export function startServer(port: number): Promise<Server> {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const httpServer = createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const page = await readFile(HTML); // read BEFORE writeHead: otherwise an error leaves the request hanging
        res.writeHead(200, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" }).end(page);
      } else if (req.method === "GET" && url.pathname === "/api/stats") {
        const days = Number(url.searchParams.get("days"));
        const body = statistics({
          project: url.searchParams.get("project") ?? undefined,
          days: Number.isInteger(days) && days > 0 && days <= 3650 ? days : null,
          model: url.searchParams.get("model") ?? undefined,
          includeBench: url.searchParams.get("bench") === "1",
        });
        res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(body));
      } else if (req.method === "GET" && url.pathname === "/api/sessions") {
        // Real usage from the Claude Code logs ("All" is capped at 365 days to bound the scan).
        const days = Number(url.searchParams.get("days"));
        const body = insights({
          project: url.searchParams.get("project") || undefined,
          model: url.searchParams.get("model") || undefined,
          days: Number.isInteger(days) && days > 0 ? days : 90,
          includeBench: url.searchParams.get("bench") === "1",
        });
        res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(body));
      } else if (req.method === "GET" && url.pathname === "/api/ping") {
        res.writeHead(200, HEADERS).end("token-eco");
      } else if (req.method === "POST" && url.pathname === "/api/stop") {
        res.writeHead(200, HEADERS).end("stopping");
        httpServer.close();
        setTimeout(() => process.exit(0), 100).unref();
      } else {
        res.writeHead(404, HEADERS).end();
      }
    } catch (e) {
      res.writeHead(500, HEADERS).end((e as Error).message);
    }
  });
  return new Promise((ok, ko) => {
    httpServer.once("error", ko);
    httpServer.listen(port, "127.0.0.1", () => ok(httpServer));
  });
}
