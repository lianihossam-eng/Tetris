import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTetrisRuntime } from "../src/runtime.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-runtime-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("builds a libfx agent with only validated active equipment and local durability", async () => {
  await withTempDir(async (directory) => {
    const workspaceRoot = join(directory, "workspace");
    const equipmentDirectory = join(directory, "equipment");
    const profileFile = join(directory, "profile.json");
    const skillsDirectory = join(equipmentDirectory, "skills");
    const stateDirectory = join(directory, "state");
    const sessionsDirectory = join(stateDirectory, "sessions");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(join(equipmentDirectory, "packs", "workspace-files"), { recursive: true });
    await mkdir(skillsDirectory, { recursive: true });
    await writeFile(join(equipmentDirectory, "packs", "workspace-files", "manifest.json"), JSON.stringify({
      id: "workspace-files",
      slot: "workspace",
      tools: ["read_file", "write_file", "edit_file"],
      requires: [],
      conflicts: [],
    }), "utf8");
    await writeFile(profileFile, JSON.stringify({ version: 1, packs: ["workspace-files"] }), "utf8");

    const runtime = await createTetrisRuntime({
      workspaceRoot,
      equipmentDirectory,
      profileFile,
      skillsDirectory,
      stateDirectory,
      sessionsDirectory,
      credentialsFile: join(directory, "credentials.json"),
      model: "gpt-6.1-terra",
    });
    try {
      assert.equal(runtime.agent.name, "tetris");
      assert.deepEqual(runtime.activeEquipment.tools, ["read_file", "write_file", "edit_file"]);
      assert.equal(runtime.toolHandlers.length, 3);
      assert.equal(runtime.agent.session().id, null);
    } finally {
      await runtime.close();
    }
  });
});
