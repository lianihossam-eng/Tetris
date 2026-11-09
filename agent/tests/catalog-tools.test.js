import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadEquipmentCatalog } from "../src/equipment/catalog.js";
import { createEquipmentRegistry } from "../src/equipment/registry.js";
import { createEquipmentTools } from "../src/tools/index.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-catalog-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeManifest(equipmentRoot, group, directory, manifest) {
  const target = join(equipmentRoot, group, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}

test("loads sorted equipment manifests and rejects directory/id mismatches", async () => {
  await withTempDir(async (directory) => {
    const root = join(directory, "equipment");
    await writeManifest(root, "packs", "zeta", { id: "zeta", slot: "web", tools: [], requires: [], conflicts: [] });
    await writeManifest(root, "packs", "alpha", { id: "alpha", slot: "search", tools: [], requires: [], conflicts: [] });
    await writeManifest(root, "skills", "review", { id: "review", slot: "skill", tools: [], requires: [], conflicts: [] });

    assert.deepEqual((await loadEquipmentCatalog(root)).map((pack) => pack.id), ["alpha", "zeta", "review"]);

    await writeFile(join(root, "skills", "review", "manifest.json"), JSON.stringify({
      id: "wrong-name",
      slot: "skill",
      tools: [],
      requires: [],
      conflicts: [],
    }), "utf8");
    await assert.rejects(loadEquipmentCatalog(root), { code: "PACK_DIRECTORY_MISMATCH" });
  });
});

test("exposes only active tool handlers in profile order", async () => {
  await withTempDir(async (workspaceRoot) => {
    const registry = createEquipmentRegistry([
      { id: "workspace-files", slot: "workspace", tools: ["read_file", "write_file", "edit_file"], requires: [], conflicts: [] },
      { id: "web-fetch", slot: "web", tools: ["web_fetch"], requires: [], conflicts: [] },
    ]);
    const activeEquipment = registry.validate({ version: 1, packs: ["web-fetch", "workspace-files"] });

    const tools = await createEquipmentTools({ activeEquipment, workspaceRoot });
    assert.deepEqual(tools.map((tool) => tool.name), ["web_fetch", "read_file", "write_file", "edit_file"]);
    assert.equal(tools.every((tool) => typeof tool.idempotent === "boolean"), true);
  });
});

test("fails closed when an active tool has no implementation", async () => {
  await assert.rejects(
    createEquipmentTools({ activeEquipment: { tools: ["unimplemented_tool"] } }),
    { code: "TOOL_HANDLER_MISSING" },
  );
});
