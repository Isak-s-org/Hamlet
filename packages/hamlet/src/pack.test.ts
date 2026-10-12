import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the packed tarball installs and runs end to end", { timeout: 180_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "hamlet-pack-"));
  const port = 48_000 + Math.floor(Math.random() * 1000);
  const token = randomBytes(16).toString("hex");
  const home = join(tmp, "home");
  // The vite config reads the app config, so building must not touch the real one.
  const env = { ...process.env, HAMLET_HOME: home, CLAUDE_CONFIG_DIR: join(tmp, "claude") };
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, token }));
  execFileSync("pnpm", ["pack", "--pack-destination", tmp], { env, stdio: "ignore" });

  const tarball = join(tmp, readdirSync(tmp).find((f) => f.endsWith(".tgz"))!);
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assert.ok(files.includes("package/dist/hamlet.js"));
  assert.ok(files.includes("package/dist/web/index.html"));
  assert.deepEqual(files.filter((f) => !f.startsWith("package/dist/")).sort(), ["package/README.md", "package/package.json"]);
  assert.deepEqual(files.filter((f) => f.endsWith(".ts")), []);

  const app = join(tmp, "app");
  execFileSync("npm", ["install", "--prefix", app, "--no-audit", "--no-fund", tarball], { stdio: "ignore" });
  const manifest = JSON.parse(readFileSync(join(app, "node_modules", "hamlet-village", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["fastify"]);
  const bin = join(app, "node_modules", ".bin", "hamlet");

  const daemon = spawn(bin, [], { cwd: app, env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => daemon.kill());
  let out = "";
  const link = await new Promise<string>((resolve) =>
    daemon.stdout.on("data", (d: Buffer) => {
      const m = (out += d.toString()).match(/one-time link\): (http:\S+)/);
      if (m) resolve(m[1]!);
    }),
  );
  assert.ok(!out.includes(token));

  const signIn = await fetch(link, { redirect: "manual" });
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Hamlet<\/title>/);
  const script = await fetch(base + html.match(/\/assets\/index-[\w-]+\.js/)![0]);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");

  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/stream`, { headers: { cookie, "sec-fetch-site": "same-origin" }, signal: ctrl.signal });
  const { value } = await stream.body!.getReader().read();
  ctrl.abort();
  assert.equal(Buffer.from(value!).toString(), 'data: {"bots":[]}\n\n');

  const settings = join(tmp, "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "opus" }));
  const hamlet = (...args: string[]) => spawnSync(bin, args, { env, encoding: "utf8" });
  assert.equal(hamlet("install", "--yes", "--settings", settings).status, 0);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks.Stop[0].hooks[0].url, `${base}/hooks`);
  assert.equal(hamlet("uninstall", "--yes", "--settings", settings).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { model: "opus" });
  assert.equal(hamlet("bogus").status, 1);
});
