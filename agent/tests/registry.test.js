import assert from "node:assert/strict";
import test from "node:test";

import {
  createEquipmentRegistry,
  DEFAULT_EQUIPMENT_POLICY,
} from "../src/equipment/registry.js";

const packs = [
  { id: "workspace", slot: "workspace", tools: ["read_file"], requires: [], conflicts: [] },
  { id: "skills-runtime", slot: "skills-runtime", tools: ["skill"], requires: [], conflicts: [] },
  {
    id: "skill-review",
    slot: "skill",
    tools: [],
    requires: ["skills-runtime"],
    conflicts: [],
    skills: [{ id: "code-review", name: "Code review", description: "Review changes", file: "skills/code-review/SKILL.md" }],
  },
  {
    id: "skill-tdd",
    slot: "skill",
    tools: [],
    requires: ["skills-runtime"],
    conflicts: [],
    skills: [{ id: "tdd", name: "TDD", description: "Test-first work", file: "skills/tdd/SKILL.md" }],
  },
  { id: "web", slot: "web", tools: ["web_fetch"], requires: [], conflicts: ["shell"] },
  { id: "shell", slot: "shell", tools: ["shell"], requires: [], conflicts: ["web"] },
  { id: "search", slot: "search", tools: ["grep_files"], requires: [], conflicts: [] },
];

const testPolicy = {
  maxTools: 4,
  slotCapacities: {
    ...DEFAULT_EQUIPMENT_POLICY.slotCapacities,
    skill: 2,
  },
};

function makeRegistry(manifests = packs, overrides = {}) {
  return createEquipmentRegistry(manifests, {
    ...testPolicy,
    ...overrides,
    slotCapacities: {
      ...testPolicy.slotCapacities,
      ...overrides.slotCapacities,
    },
  });
}

const profile = (...ids) => ({ version: 1, packs: ids });

test("validates active tools and skills without loading unused equipment", () => {
  const result = makeRegistry().validate(profile("workspace", "skills-runtime", "skill-review", "web"));

  assert.deepEqual(result.tools, ["read_file", "skill", "web_fetch"]);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["code-review"]);
  assert.equal(result.toolCount, 3);
  assert.deepEqual(result.profile.packs, ["workspace", "skills-runtime", "skill-review", "web"]);
});

test("activation adds only declared dependencies and does not mutate the current profile", () => {
  const registry = makeRegistry();
  const current = profile("workspace");
  const result = registry.activate(current, "skill-review");

  assert.deepEqual(result.added, ["skills-runtime", "skill-review"]);
  assert.deepEqual(result.profile, profile("workspace", "skills-runtime", "skill-review"));
  assert.deepEqual(current, profile("workspace"));
});

test("activation is atomic when a declared conflict would be introduced", () => {
  const registry = makeRegistry();
  const current = profile("web");

  assert.throws(() => registry.activate(current, "shell"), { code: "CONFLICTING_PACKS" });
  assert.deepEqual(current, profile("web"));
});

test("rejects an active pack whose required equipment is missing", () => {
  assert.throws(
    () => makeRegistry().validate(profile("skill-review")),
    { code: "MISSING_DEPENDENCY" },
  );
});

test("rejects dependency cycles while building the catalog", () => {
  const cyclic = [
    { id: "alpha", slot: "workspace", tools: [], requires: ["beta"], conflicts: [] },
    { id: "beta", slot: "search", tools: [], requires: ["alpha"], conflicts: [] },
  ];

  assert.throws(() => makeRegistry(cyclic), { code: "DEPENDENCY_CYCLE" });
});

test("rejects duplicate tool names in the active equipment", () => {
  const duplicateTool = {
    id: "alternate-reader",
    slot: "search",
    tools: ["read_file"],
    requires: [],
    conflicts: [],
  };

  assert.throws(
    () => makeRegistry([...packs, duplicateTool]).validate(profile("workspace", "alternate-reader")),
    { code: "DUPLICATE_TOOL" },
  );
});

test("enforces the total tool budget", () => {
  assert.throws(
    () => makeRegistry(packs, { maxTools: 1 }).validate(profile("workspace", "web")),
    { code: "TOOL_BUDGET_EXCEEDED" },
  );
});

test("enforces slot capacity for multiple skills", () => {
  const thirdSkill = {
    id: "skill-research",
    slot: "skill",
    tools: [],
    requires: ["skills-runtime"],
    conflicts: [],
    skills: [{ id: "research", name: "Research", description: "Research sources", file: "skills/research/SKILL.md" }],
  };

  assert.throws(
    () => makeRegistry([...packs, thirdSkill]).validate(
      profile("skills-runtime", "skill-review", "skill-tdd", "skill-research"),
    ),
    { code: "SLOT_CAPACITY_EXCEEDED" },
  );
});

test("does not remove equipment while an active pack depends on it", () => {
  const registry = makeRegistry();
  const current = profile("skills-runtime", "skill-review");

  assert.throws(() => registry.deactivate(current, "skills-runtime"), { code: "PACK_IN_USE" });
  assert.deepEqual(current, profile("skills-runtime", "skill-review"));

  const result = registry.deactivate(current, "skill-review");
  assert.deepEqual(result.profile, profile("skills-runtime"));
  assert.deepEqual(current, profile("skills-runtime", "skill-review"));
});
