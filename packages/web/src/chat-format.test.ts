import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot, ChatEntry } from "@hamlet/shared/world";
import { allCommands, bytes, subagentHtml, tokens, diffHtml, esc, inputHtml, matchCommands, menuHtml, menuQuery, prose, resultHtml, Seen, sendBlock, setMarkdown, shortPath, tailSplit, textHtml, toolSummary } from "./chat-format.js";

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

const cmd = (name: string, description = "") => ({ name, description });

test("the menu opens for a lone slash word", () => {
  assert.equal(menuQuery("/"), "");
  assert.equal(menuQuery("/comp"), "comp");
  assert.equal(menuQuery("/compact now"), undefined);
  assert.equal(menuQuery("hello /x"), undefined);
  assert.equal(menuQuery("/a\n"), undefined);
});

test("prefix matches come first, including after a plugin prefix", () => {
  const list = [cmd("simplify"), cmd("superpowers:brainstorming"), cmd("init"), cmd("brain-dump"), cmd("rebrain")];
  assert.deepEqual(matchCommands("brain", list).map((c) => c.name), ["brain-dump", "superpowers:brainstorming", "rebrain"]);
  assert.deepEqual(matchCommands("SIM", list).map((c) => c.name), ["simplify"]);
  const co = [cmd("chrome-devtools-mcp:cookie-debugging"), cmd("compact"), cmd("superpowers:receiving-code-review"), cmd("code-review")];
  assert.deepEqual(matchCommands("co", co).map((c) => c.name), ["code-review", "compact", "chrome-devtools-mcp:cookie-debugging", "superpowers:receiving-code-review"]);
  assert.equal(matchCommands("", Array.from({ length: 80 }, (_, i) => cmd(`c${i}`))).length, 50);
});

test("a session's command wins over a built-in of the same name", () => {
  const all = allCommands([cmd("clear", "custom clear"), cmd("init")]);
  assert.deepEqual(all.filter((c) => c.name === "clear"), [{ name: "clear", description: "custom clear" }]);
  assert.ok(all.some((c) => c.name === "compact" && c.builtin));
});

test("menu rows never turn a command into markup", () => {
  const html = menuHtml([{ name: "<img src=x>", description: "<script>alert(1)</script>", builtin: true }], 0);
  assert.ok(!html.includes("<img") && !html.includes("<script"), html);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /built-in/);
});

test("only a live cmux session without a held prompt can be sent to", () => {
  const bot = { sessionId: "s", repo: "r", branch: "b", cwd: "/", state: "idle", since: 0 } as Bot;
  assert.equal(sendBlock(undefined)?.readOnly, true);
  assert.match(sendBlock(bot)!.reason, /can't find this session's terminal/);
  assert.match(sendBlock({ ...bot, terminal: { kind: "wt", session: "x" } })!.reason, /Windows Terminal/);
  const cmux = { ...bot, terminal: { kind: "cmux", surfaceId: "s", workspaceId: "w" } } as Bot;
  assert.equal(sendBlock(cmux), undefined);
  assert.deepEqual(sendBlock({ ...cmux, permission: { id: 1, toolName: "Bash", toolInput: {}, cwd: "/" } }), { reason: "Answer the WAITING prompt first.", readOnly: false, label: "WAITING" });
  assert.deepEqual(sendBlock({ ...cmux, state: "needs_input" }), { reason: "Answer the WAITING prompt first.", readOnly: false, label: "WAITING" });
  assert.equal(sendBlock(undefined)?.label, "ENDED");
  assert.equal(sendBlock(bot)?.label, "READ-ONLY");
  assert.equal(sendBlock({ ...bot, terminal: { kind: "wt", session: "x" } })?.label, "READ-ONLY");
});

test("long paths keep their tail", () => {
  assert.equal(shortPath("/Users/me/x"), "/Users/me/x");
  assert.equal(shortPath("/Users/isak.gerre/Documents/projects/Hamlet/packages/web", 30), "…/projects/Hamlet/packages/web");
  assert.equal(shortPath("/"), "/");
  assert.ok(shortPath("/a/" + "b".repeat(60), 20).length <= 20);
});

test("prose is plain until markdown has loaded, then markdown; agent reports and plans use it", () => {
  assert.equal(prose("**hi**"), `<div class="md">${textHtml("**hi**")}</div>`);
  setMarkdown((t) => `<md>${t}</md>`);
  try {
    assert.equal(prose("**hi**"), `<div class="md"><md>**hi**</md></div>`);
    assert.match(resultHtml(result({ text: "report" }), true), /<md>report<\/md>/);
    assert.doesNotMatch(resultHtml(result({ text: "ls output" })), /<md>/);
    assert.match(inputHtml("ExitPlanMode", { plan: "# Plan" }), /<md># Plan<\/md>/);
  } finally {
    setMarkdown(undefined);
  }
});

test("the tail keeps the last n top-level entries, with what belongs to them", () => {
  const e = (uuid: string, o: object) => ({ uuid, at: "", ...o }) as ChatEntry;
  const list = [
    e("p1", { kind: "prompt", text: "a" }),
    e("t1", { kind: "tool", id: "T1", name: "Agent", input: {} }),
    e("s1", { kind: "text", text: "sub", parent: "T1" }),
    e("x1", { kind: "text", text: "b" }),
    e("r1", { kind: "result", toolUseId: "T1", text: "", isError: false }),
    e("x2", { kind: "text", text: "c" }),
  ];
  const { older, tail } = tailSplit(list, 2);
  assert.deepEqual(tail.map((x) => x.uuid), ["x1", "r1", "x2"]);
  assert.deepEqual(older.map((x) => x.uuid), ["p1", "t1", "s1"]);
  assert.deepEqual(tailSplit(list, 10), { older: [], tail: list });
});

test("a subagent row says its state, counts and time, running against now", () => {
  const s = { agentId: "a", parent: "T", type: "Explore", description: "<b>x</b>", tokens: 45_210, tools: 1, start: "2026-01-01T00:00:00Z", last: "2026-01-01T00:01:03Z" };
  const done = subagentHtml(s, undefined, 0);
  assert.match(done, /✓/);
  assert.match(done, /1 tool · 45\.2k tok · 1m 3s/);
  assert.ok(!done.includes("<b>"));
  const running = subagentHtml(s, { agentId: "a", activity: "Reading feed.ts" }, Date.parse("2026-01-01T00:00:05Z"));
  assert.match(running, /●[\s\S]*5s[\s\S]*Reading feed\.ts/);
  assert.match(subagentHtml({ ...s, failed: true }, undefined, 0), /✗/);
  assert.equal(tokens(999), "999");
});
