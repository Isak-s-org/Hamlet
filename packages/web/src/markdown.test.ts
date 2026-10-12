import assert from "node:assert/strict";
import { test } from "node:test";
import { mdHtml } from "./markdown.js";

test("raw HTML stays text", () => {
  const html = mdHtml(`hi <script>alert(1)</script> <img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<script") && !html.includes("<img"), html);
});

test("unsafe links are not links, images never load", () => {
  assert.ok(!mdHtml("[x](javascript:alert(1))").includes("<a"), mdHtml("[x](javascript:alert(1))"));
  const img = mdHtml("![logo](https://example.com/a.png)");
  assert.ok(!img.includes("<img"), img);
  assert.match(img, /<a href="https:\/\/example\.com\/a\.png"[^>]*>logo<\/a>/);
  assert.ok(!mdHtml("![x](javascript:alert(1))").includes("<a"));
});

test("links open in a new tab without an opener", () => {
  assert.match(mdHtml("[docs](https://example.com)"), /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("Claude's usual markdown renders", () => {
  const html = mdHtml("## Plan\n\n- one\n  - nested\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nline one\nline two");
  for (const bit of ["<h2>", "<ul>", '<div class="table"><table>', '<pre class="code" data-lang="ts">', "const x = 1;", "line one<br>"]) assert.ok(html.includes(bit), bit);
});
