import assert from "node:assert/strict";
import { test } from "node:test";
import { type Settings, withOurs, withoutOurs } from "./settings.js";

test("install is idempotent and uninstall restores the user's settings", () => {
  const original: Settings = {
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] }],
    },
  };
  const installed = withOurs(original, "http://127.0.0.1:4747/hooks", "secret");
  assert.deepEqual(withOurs(installed, "http://127.0.0.1:4747/hooks", "secret"), installed);
  // A port change still replaces the old entries instead of adding a second set.
  const moved = withOurs(installed, "http://127.0.0.1:5000/hooks", "secret");
  assert.equal(moved.hooks!.Stop!.length, 1);
  assert.deepEqual(withoutOurs(moved), original);
});
