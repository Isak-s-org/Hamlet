import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEntry } from "@hamlet/shared/world";
import { bytes, diffHtml, esc, inputHtml, resultHtml, Seen, textHtml, toolSummary } from "./chat-format.js";

const result = (o: Partial<Extract<ChatEntry, { kind: "result" }>>) =>
  ({ uuid: "r", at: "", kind: "result", toolUseId: "t", text: "", isError: false, ...o }) as Extract<ChatEntry, { kind: "result" }>;

test("transcript text never becomes markup", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  for (const html of [
    textHtml(evil),
    textHtml("```\n" + evil + "\n```"),
    resultHtml(result({ text: evil })),
    diffHtml("Edit", { old_string: evil, new_string: evil })!,
    inputHtml("Bash", { command: evil }),
    inputHtml("Grep", { pattern: evil }),
    esc(toolSummary("Read", { file_path: evil })),
  ]) {
    assert.ok(!html.includes("<img"), html);
  }
});

test("text keeps line breaks and turns fences into code blocks", () => {
  assert.equal(textHtml("one\ntwo"), `<p class="say">one\ntwo</p>`);
  assert.equal(textHtml("Run:\n```bash\npnpm test\n```\nDone."), `<p class="say">Run:</p><pre class="code">pnpm test</pre><p class="say">Done.</p>`);
  assert.equal(textHtml("```\nunclosed"), `<pre class="code">unclosed</pre>`);
});

test("tool summaries name what the call is about", () => {
  assert.equal(toolSummary("Bash", { command: "pnpm test\nmore" }), "pnpm test");
  assert.equal(toolSummary("Edit", { file_path: "/src/bots.ts" }), "/src/bots.ts");
  assert.equal(toolSummary("Agent", { description: "Review the diff", prompt: "…" }), "Review the diff");
  assert.equal(toolSummary("Grep", { pattern: "todo" }), "todo");
  assert.equal(toolSummary("Mystery", {}), "");
  assert.equal(toolSummary("Bash", { command: "x".repeat(200) }).length, 120);
});

test("edits show removed then added lines; Write shows only added ones", () => {
  assert.equal(
    diffHtml("Edit", { old_string: "a\nb", new_string: "c" }),
    `<pre class="diff"><span class="del">- a</span><span class="del">- b</span><span class="add">+ c</span></pre>`,
  );
  assert.equal(diffHtml("Write", { content: "x" }), `<pre class="diff"><span class="add">+ x</span></pre>`);
  assert.equal(diffHtml("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "" }] })!.match(/<pre/g)!.length, 2);
  assert.equal(diffHtml("MultiEdit", { edits: [null, { old_string: "a" }] })!.match(/<pre/g)!.length, 2);
  assert.equal(diffHtml("Bash", { command: "ls" }), undefined);
});

test("results show errors, empty output and truncation", () => {
  assert.equal(resultHtml(result({ text: "ok" })), `<pre class="out">ok</pre>`);
  assert.equal(resultHtml(result({ text: "", isError: true })), `<pre class="out err">(no output)</pre>`);
  assert.ok(resultHtml(result({ text: "x", truncated: 1_234_567 })).includes("Result truncated (1.2 MB)"));
  assert.equal(bytes(34_000), "33 KB");
});

test("Seen drops entries a reconnect sends again", () => {
  const seen = new Seen();
  const e = (uuid: string) => ({ uuid, at: "", kind: "text", text: uuid }) as ChatEntry;
  assert.deepEqual(seen.fresh([e("a"), e("b")]).map((x) => x.uuid), ["a", "b"]);
  assert.deepEqual(seen.fresh([e("a"), e("b"), e("c")]).map((x) => x.uuid), ["c"]);
  seen.clear();
  assert.equal(seen.fresh([e("a")]).length, 1);
});
