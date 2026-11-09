import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCraftTools } from "../src/tools/craft.js";

async function withWorkspace(run) {
  const parent = await mkdtemp(join(tmpdir(), "tetris-craft-"));
  const workspace = join(parent, "workspace");
  await mkdir(workspace);
  try {
    await run({ parent, workspace });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("Craft operations reject targets outside the workspace", async () => {
  await withWorkspace(async ({ parent, workspace }) => {
    const tools = await createCraftTools({
      workspaceRoot: workspace,
      stateDirectory: join(parent, "state"),
      command: "craft-anything-cli-that-does-not-exist",
    });
    const chat = tools.find((tool) => tool.name === "craft_chat");
    const report = tools.find((tool) => tool.name === "craft_report");

    await assert.rejects(chat.execute({ question: "Read this", target: "../outside" }, {}), { code: "INVALID_TARGET" });
    await assert.rejects(report.execute({ target: "../outside" }, {}), { code: "INVALID_TARGET" });
  });
});

test("Craft CLI failures remain explicit instead of returning empty reports", async () => {
  await withWorkspace(async ({ parent, workspace }) => {
    const tools = await createCraftTools({
      workspaceRoot: workspace,
      stateDirectory: join(parent, "state"),
      command: "craft-anything-cli-that-does-not-exist",
    });
    const chat = tools.find((tool) => tool.name === "craft_chat");

    await assert.rejects(chat.execute({ question: "Inspect this repository" }, {}), { code: "CRAFT_NOT_INSTALLED" });
  });
});
