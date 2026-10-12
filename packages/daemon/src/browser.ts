import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_PREFIX, TOKEN_HEADER } from "@hamlet/shared";

type Rule = [status: 401 | 403, refuses: (request: FastifyRequest) => boolean];
type Asset = { type: string; body: Buffer };

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const COOKIE = "hamlet_session";
// Chrome caps cookie lifetimes at 400 days.
const MAX_AGE = 400 * 24 * 3600;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/**
 * Lets browsers reach the daemon safely. Always installs the request gate: Host must be loopback,
 * cross-site and same-site requests are refused (except top-level navigations outside /api), and
 * /api needs the token header or, from the same origin, the session cookie. With `webDir`, also
 * serves the built UI and a one-time sign-in link that trades for the cookie.
 * Call before registering any route. Returns the sign-in path ("/auth?code=…") when the UI is served.
 */
export function serveBrowsers(app: FastifyInstance, token: string, webDir: string | undefined): string | undefined {
  // Derived, so the hook token never reaches a browser and a new token signs every browser out.
  const session = createHmac("sha256", token).update("hamlet browser session").digest("base64url");
  // Every pair is checked, so a same-named cookie set by another local port can't shadow ours.
  const signedIn = (cookie: string | undefined) => (cookie ?? "").split(/;\s*/).includes(`${COOKIE}=${session}`);

  const rules: Rule[] = [
    // DNS rebinding arrives with the attacker's name as Host. The port is free so the vite proxy's localhost:5173 passes.
    [403, (r) => !LOOPBACK.has(r.hostname.toLowerCase())],
    // Other sites and other local ports; only a top-level navigation may open the UI from a link.
    [403, (r) => {
      const site = r.headers["sec-fetch-site"];
      if (site === undefined || site === "same-origin" || site === "none") return false;
      const navigation = r.method === "GET" && r.headers["sec-fetch-mode"] === "navigate" && r.headers["sec-fetch-dest"] === "document";
      return !navigation || r.url.startsWith(API_PREFIX);
    }],
    // The cookie fails closed without Fetch Metadata, so only a browser on our own origin can use it.
    [401, (r) =>
      r.url.startsWith(API_PREFIX) &&
      r.headers[TOKEN_HEADER] !== token &&
      !(r.headers["sec-fetch-site"] === "same-origin" && signedIn(r.headers.cookie))],
  ];
  app.addHook("onRequest", async (request, reply) => {
    const refusal = rules.find(([, refuses]) => refuses(request));
    if (refusal) return reply.code(refusal[0]).send();
  });

  if (!webDir) return undefined;
  const { index, assets } = loadUi(webDir);
  const mint = () => randomBytes(16).toString("base64url");
  let code = mint();

  // A 303 to a clean / keeps the code out of the address bar and out of any Referer.
  app.get("/auth", (request, reply) => {
    if ((request.query as { code?: unknown }).code === code) {
      code = mint();
      console.log(`Browser signed in. Next one-time link: http://127.0.0.1:${request.socket.localPort}/auth?code=${code}`);
      reply.header("set-cookie", `${COOKIE}=${session}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax`);
    }
    return reply.code(303).header("location", "/").send();
  });

  app.get("/", (request, reply) => {
    reply.header("cache-control", "no-store");
    if (signedIn(request.headers.cookie)) return reply.type(TYPES[".html"]!).send(index);
    return reply.code(401).type("text/plain; charset=utf-8").send("Open the one-time link hamlet printed in its terminal to sign in.\n");
  });

  app.get("/*", (request, reply) => {
    const asset = assets.get("/" + (request.params as { "*": string })["*"]);
    if (!asset) return reply.code(404).send();
    return reply.type(asset.type).header("x-content-type-options", "nosniff").send(asset.body);
  });

  return `/auth?code=${code}`;
}

/** Reads the whole build once; requests only ever look up exact keys, so no request path reaches the filesystem. */
function loadUi(dir: string): { index: Buffer; assets: Map<string, Asset> } {
  const assets = new Map<string, Asset>();
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!statSync(join(dir, rel)).isFile()) continue;
    const type = TYPES[extname(rel)];
    if (!type) throw new Error(`no content type for ${rel}`);
    assets.set("/" + rel.split(sep).join("/"), { type, body: readFileSync(join(dir, rel)) });
  }
  const index = assets.get("/index.html");
  if (!index) throw new Error(`no index.html in ${dir}`);
  // Only the gated / serves the page.
  assets.delete("/index.html");
  return { index: index.body, assets };
}
