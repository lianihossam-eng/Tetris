import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadEquipmentCatalog } from "../src/equipment/catalog.js";
import { createEquipmentRegistry } from "../src/equipment/registry.js";
import { loadProfile } from "../src/equipment/profile.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("default equipment profile exposes executable tools without OMP skill documents", async () => {
  const equipmentRoot = join(packageRoot, "equipment");
  const catalog = await loadEquipmentCatalog(equipmentRoot);
  const registry = createEquipmentRegistry(catalog);
  const profile = await loadProfile(join(packageRoot, "profile.json"), { registry });
  const active = registry.validate(profile);

  assert.equal(active.toolCount, 9);
  assert.deepEqual(active.tools, [
    "read_file",
    "write_file",
    "edit_file",
    "glob_files",
    "grep_files",
    "shell",
    "web_fetch",
    "todo",
    "task",
  ]);
  assert.deepEqual(active.skills, []);
  assert.deepEqual(active.profile.packs, [
    "workspace-files",
    "workspace-search",
    "shell",
    "web-fetch",
    "planning",
    "delegation",
  ]);
  assert.equal(active.packs.some(({ id }) => id === "craft"), false);
});
