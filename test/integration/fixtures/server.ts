import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Minimal HTTP server that serves self-contained fixture HTML pages + a slow
 * API endpoint for SPA fixtures that need XHR. Each fixture is a static .html
 * file in this directory — the test suite renders each via captatum's real
 * pipeline and asserts the expected content strings are in the extraction.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const path = url.pathname;

      // Error-page route: serve the fixture HTML with a non-200 status.
      if (path === "/error-404") {
        try {
          const html = readFileSync(join(__dirname, "error-page-404.html"), "utf-8");
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch { res.writeHead(500); res.end("fixture read error"); }
        return;
      }

      // Slow API endpoint (2s delay) for SPA fixtures that load content via XHR.
      if (path === "/api/slow-data") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            tracks: ["Oncology Drug Discovery", "Genomic Analysis", "Clinical Trial Design"],
            prizes: ["$10,000", "$5,000", "$2,500"],
            rules: "Teams of 1-4. Must use Claude API. 48 hours.",
          }));
        }, 2000);
        return;
      }

      // Service worker + the content it would serve, for the SW-mediated fixture.
      // The renderer blocks service workers, so the page's register() rejects and the
      // fetch never runs — the "secret" below is ONLY reachable via a live SW.
      if (path === "/sw.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(
          "self.addEventListener('install', (e) => self.skipWaiting());\n" +
            "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n" +
            "self.addEventListener('fetch', (e) => {\n" +
            "  if (new URL(e.request.url).pathname === '/api/sw-content') {\n" +
            "    e.respondWith(new Response('SW-served secret content'));\n" +
            "  }\n" +
            "});\n",
        );
        return;
      }
      if (path === "/api/sw-content") {
        // Direct (non-SW) fetch returns nothing — only the SW serves the real body.
        res.writeHead(204);
        res.end();
        return;
      }

      // Serve fixture HTML: /spa-late-load → spa-late-load.html
      const name = path.replace(/^\//, "");
      if (!name || name.includes("..")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      try {
        const html = readFileSync(join(__dirname, `${name}.html`), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end(`Fixture not found: ${name}`);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
