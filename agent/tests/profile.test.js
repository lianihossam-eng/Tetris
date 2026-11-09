import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEquipmentRegistry, DEFAULT_EQUIPMENT_POLICY } from "../src/equipment/registry.js";
import { loadProfile, saveProfileAtomically } from "../src/equipment/profile.js";

const registry = createEquipmentRegistry([
  { id: "workspace", slot: "workspace", tools: ["read_file"], requires: [], conflicts: [] },
], {
  ...DEFAULT_EQUIPMENT_POLICY,
  slotCapacities: { ...DEFAULT_EQUIPMENT_POLICY.slotCapacities, workspace: 1 },
});

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-profile-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uses a validated default when the profile file does not exist", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "profile.json");
    const result = await loadProfile(path, {
      registry,
      defaultProfile: { version: 1, packs: ["workspace"] },
    });

    assert.deepEqual(result, { version: 1, packs: ["workspace"] });
    assert.deepEqual(await readdir(directory), []);
  });
});

test("writes a valid profile atomically with private file permissions", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "nested", "profile.json");
    const profile = { version: 1, packs: ["workspace"] };

    await saveProfileAtomically(path, profile, { registry });

    assert.deepEqual(await loadProfile(path, { registry }), profile);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(profile, { version: 1, packs: ["workspace"] });
  });
});

test("rejects invalid changes without replacing the last valid profile", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "profile.json");
    const validProfile = { version: 1, packs: ["workspace"] };
    await saveProfileAtomically(path, validProfile, { registry });
    const before = await readFile(path, "utf8");

    await assert.rejects(
      saveProfileAtomically(path, { version: 1, packs: ["missing"] }, { registry }),
      { code: "UNKNOWN_PACK" },
    );

    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(directory), ["profile.json"]);
  });
});

test("rejects malformed persisted profiles instead of silently resetting them", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "profile.json");
    await writeFile(path, "{broken", "utf8");

    await assert.rejects(loadProfile(path, { registry }), { code: "INVALID_PROFILE_JSON" });
    assert.equal(await readFile(path, "utf8"), "{broken");
  });
});
