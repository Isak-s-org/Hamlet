import assert from "node:assert/strict";
import { test } from "node:test";
import { insetOf } from "./motion.js";

const box = { top: 0, left: 0, width: 1000, height: 800 };

test("insetOf clips a box down to a rect inside it", () => {
  const r = { top: 100, left: 200, right: 600, bottom: 300 };
  assert.equal(insetOf(r, box), "inset(100px 400px 500px 200px round 4px)");
});

test("insetOf measures from the box, not the viewport", () => {
  const r = { top: 150, left: 250, right: 650, bottom: 350 };
  assert.equal(insetOf(r, { ...box, top: 50, left: 50 }), "inset(100px 400px 500px 200px round 4px)");
});

test("with no rect, insetOf starts from a point at the centre", () => {
  assert.equal(insetOf(undefined, box), "inset(400px 500px 400px 500px round 4px)");
});
