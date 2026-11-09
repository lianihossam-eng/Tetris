import assert from "node:assert/strict";
import test from "node:test";

import { createTaskTool } from "../src/tools/task.js";

test("task tool requires a real subagent runner", () => {
  assert.throws(() => createTaskTool(), { code: "INVALID_CONFIGURATION" });
});

test("task tool rejects invalid mode and empty goals before delegation", async () => {
  let invoked = false;
  const tool = createTaskTool(async () => {
    invoked = true;
    return { text: "unexpected" };
  });

  await assert.rejects(tool.execute({ goal: "Inspect this", mode: "recursive" }, {}), { code: "INVALID_INPUT" });
  await assert.rejects(tool.execute({ goal: "   " }, {}), { code: "INVALID_INPUT" });
  assert.equal(invoked, false);
});
