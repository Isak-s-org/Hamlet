import { cpSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const { dependencies } = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/hamlet.ts"],
  outdir: "dist",
  bundle: true,
  // Lazy chunks, so `hamlet install` never loads the daemon or fastify.
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Runtime dependencies install from npm; the private workspace packages are inlined.
  external: Object.keys(dependencies),
});
cpSync("../web/dist", "dist/web", { recursive: true });
cpSync("../../LICENSE", "dist/LICENSE");
