const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROFILE_VERSION = 1;

export const DEFAULT_EQUIPMENT_POLICY = Object.freeze({
  maxTools: 12,
  slotCapacities: Object.freeze({
    workspace: 1,
    search: 1,
    shell: 1,
    web: 1,
    planning: 1,
    delegation: 1,
    "skills-runtime": 1,
    skill: 6,
    craft: 1,
  }),
});

export class EquipmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EquipmentError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new EquipmentError(code, message, details);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readStringArray(value, field, packId) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail("INVALID_PACK", `Pack ${packId} must define ${field} as an array of non-empty strings.`, { packId, field });
  }
  const result = [...value];
  if (new Set(result).size !== result.length) {
    fail("INVALID_PACK", `Pack ${packId} contains duplicate entries in ${field}.`, { packId, field });
  }
  return result;
}

function normalizeSkill(skill, packId, index) {
  if (!isRecord(skill)
    || typeof skill.id !== "string"
    || !ID_PATTERN.test(skill.id)
    || typeof skill.name !== "string"
    || skill.name.trim().length === 0
    || typeof skill.description !== "string"
    || skill.description.trim().length === 0
    || typeof skill.file !== "string"
    || skill.file.length === 0) {
    fail("INVALID_PACK", `Pack ${packId} has an invalid skill at index ${index}.`, { packId, index });
  }

  const segments = skill.file.split(/[\\/]+/);
  if (/^[a-zA-Z]:/.test(skill.file)
    || skill.file.startsWith("/")
    || segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)
    || skill.file.includes("\0")) {
    fail("INVALID_PACK", `Skill ${skill.id} in pack ${packId} must use a safe relative file path.`, { packId, skillId: skill.id });
  }

  return Object.freeze({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    file: skill.file,
  });
}

function normalizePack(manifest) {
  if (!isRecord(manifest)
    || typeof manifest.id !== "string"
    || !ID_PATTERN.test(manifest.id)
    || typeof manifest.slot !== "string"
    || !ID_PATTERN.test(manifest.slot)) {
    fail("INVALID_PACK", "Each equipment pack must have a kebab-case id and slot.");
  }

  const id = manifest.id;
  const tools = readStringArray(manifest.tools, "tools", id);
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) {
      fail("INVALID_PACK", `Pack ${id} has an invalid tool name: ${tool}.`, { packId: id, tool });
    }
  }

  const requires = readStringArray(manifest.requires, "requires", id);
  for (const dependency of requires) {
    if (!ID_PATTERN.test(dependency)) {
      fail("INVALID_PACK", `Pack ${id} has an invalid dependency id: ${dependency}.`, { packId: id, dependency });
    }
  }

  const conflicts = readStringArray(manifest.conflicts, "conflicts", id);
  for (const conflict of conflicts) {
    if (!ID_PATTERN.test(conflict)) {
      fail("INVALID_PACK", `Pack ${id} has an invalid conflict id: ${conflict}.`, { packId: id, conflict });
    }
  }
  if (conflicts.includes(id)) {
    fail("INVALID_PACK", `Pack ${id} cannot conflict with itself.`, { packId: id });
  }
  if (requires.some((dependency) => conflicts.includes(dependency))) {
    fail("INVALID_PACK", `Pack ${id} cannot require a pack that it conflicts with.`, { packId: id });
  }

  if (manifest.skills !== undefined && !Array.isArray(manifest.skills)) {
    fail("INVALID_PACK", `Pack ${id} must define skills as an array.`, { packId: id });
  }
  const skills = (manifest.skills ?? []).map((skill, index) => normalizeSkill(skill, id, index));
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    fail("INVALID_PACK", `Pack ${id} contains duplicate skill ids.`, { packId: id });
  }

  const copy = structuredClone(manifest);
  return Object.freeze({
    ...copy,
    id,
    slot: manifest.slot,
    tools: Object.freeze(tools),
    requires: Object.freeze(requires),
    conflicts: Object.freeze(conflicts),
    skills: Object.freeze(skills),
  });
}

function normalizePolicy(policy) {
  if (!isRecord(policy)
    || !Number.isSafeInteger(policy.maxTools)
    || policy.maxTools < 0
    || !isRecord(policy.slotCapacities)) {
    fail("INVALID_POLICY", "Equipment policy needs a non-negative maxTools and slotCapacities map.");
  }

  const slotCapacities = {};
  for (const [slot, capacity] of Object.entries(policy.slotCapacities)) {
    if (!ID_PATTERN.test(slot) || !Number.isSafeInteger(capacity) || capacity < 0) {
      fail("INVALID_POLICY", `Invalid capacity for equipment slot ${slot}.`, { slot, capacity });
    }
    slotCapacities[slot] = capacity;
  }

  return Object.freeze({
    maxTools: policy.maxTools,
    slotCapacities: Object.freeze(slotCapacities),
  });
}

function validateCatalog(manifests, policy) {
  if (!Array.isArray(manifests)) fail("INVALID_PACK", "Equipment catalog must be an array.");

  const packs = new Map();
  for (const manifest of manifests) {
    const pack = normalizePack(manifest);
    if (packs.has(pack.id)) {
      fail("DUPLICATE_PACK", `Equipment catalog contains pack ${pack.id} more than once.`, { packId: pack.id });
    }
    if (!Object.hasOwn(policy.slotCapacities, pack.slot)) {
      fail("UNKNOWN_SLOT", `Pack ${pack.id} uses unconfigured slot ${pack.slot}.`, { packId: pack.id, slot: pack.slot });
    }
    packs.set(pack.id, pack);
  }

  for (const pack of packs.values()) {
    for (const dependency of pack.requires) {
      if (!packs.has(dependency)) {
        fail("UNKNOWN_DEPENDENCY", `Pack ${pack.id} requires unknown pack ${dependency}.`, { packId: pack.id, dependency });
      }
    }
    for (const conflict of pack.conflicts) {
      if (!packs.has(conflict)) {
        fail("UNKNOWN_CONFLICT", `Pack ${pack.id} conflicts with unknown pack ${conflict}.`, { packId: pack.id, conflict });
      }
    }
  }

  const complete = new Set();
  const active = new Set();
  const path = [];
  function visit(packId) {
    if (complete.has(packId)) return;
    if (active.has(packId)) {
      const start = path.indexOf(packId);
      const cycle = [...path.slice(start), packId];
      fail("DEPENDENCY_CYCLE", `Equipment dependency cycle: ${cycle.join(" -> ")}.`, { cycle });
    }

    active.add(packId);
    path.push(packId);
    for (const dependency of packs.get(packId).requires) visit(dependency);
    path.pop();
    active.delete(packId);
    complete.add(packId);
  }
  for (const packId of packs.keys()) visit(packId);

  return packs;
}

function validateProfile(profile, packs, policy) {
  if (!isRecord(profile)
    || profile.version !== PROFILE_VERSION
    || !Array.isArray(profile.packs)
    || profile.packs.some((packId) => typeof packId !== "string")) {
    fail("INVALID_PROFILE", `Equipment profile must have version ${PROFILE_VERSION} and a packs array.`);
  }
  if (Object.keys(profile).some((key) => key !== "version" && key !== "packs")) {
    fail("INVALID_PROFILE", "Equipment profile contains unsupported fields.");
  }

  const packIds = [...profile.packs];
  if (new Set(packIds).size !== packIds.length) {
    fail("DUPLICATE_PACK", "Equipment profile lists a pack more than once.");
  }

  const selected = new Set(packIds);
  const activePacks = [];
  const slotCounts = new Map();
  const toolNames = new Set();
  const tools = [];
  const skillIds = new Set();
  const skills = [];

  for (const packId of packIds) {
    const pack = packs.get(packId);
    if (!pack) fail("UNKNOWN_PACK", `Equipment profile selects unknown pack ${packId}.`, { packId });
    activePacks.push(pack);
  }

  for (const pack of activePacks) {
    for (const dependency of pack.requires) {
      if (!selected.has(dependency)) {
        fail("MISSING_DEPENDENCY", `Pack ${pack.id} requires active pack ${dependency}.`, { packId: pack.id, dependency });
      }
    }

    for (const conflict of pack.conflicts) {
      if (selected.has(conflict)) {
        fail("CONFLICTING_PACKS", `Packs ${pack.id} and ${conflict} cannot be active together.`, { packId: pack.id, conflict });
      }
    }

    const slotCount = (slotCounts.get(pack.slot) ?? 0) + 1;
    slotCounts.set(pack.slot, slotCount);
    const slotCapacity = policy.slotCapacities[pack.slot];
    if (slotCount > slotCapacity) {
      fail("SLOT_CAPACITY_EXCEEDED", `Slot ${pack.slot} allows ${slotCapacity} pack(s); profile selects ${slotCount}.`, {
        slot: pack.slot,
        capacity: slotCapacity,
        count: slotCount,
      });
    }

    for (const tool of pack.tools) {
      if (toolNames.has(tool)) {
        fail("DUPLICATE_TOOL", `Tool ${tool} is provided by more than one active pack.`, { tool, packId: pack.id });
      }
      toolNames.add(tool);
      tools.push(tool);
    }

    for (const skill of pack.skills) {
      if (skillIds.has(skill.id)) {
        fail("DUPLICATE_SKILL", `Skill ${skill.id} is provided by more than one active pack.`, { skillId: skill.id });
      }
      skillIds.add(skill.id);
      skills.push({ ...skill });
    }
  }

  if (tools.length > policy.maxTools) {
    fail("TOOL_BUDGET_EXCEEDED", `Equipment exposes ${tools.length} tools; the budget is ${policy.maxTools}.`, {
      maxTools: policy.maxTools,
      toolCount: tools.length,
    });
  }

  return {
    profile: { version: PROFILE_VERSION, packs: packIds },
    packs: activePacks.map((pack) => structuredClone(pack)),
    tools,
    skills,
    toolCount: tools.length,
  };
}

export function createEquipmentRegistry(manifests, policy = DEFAULT_EQUIPMENT_POLICY) {
  const normalizedPolicy = normalizePolicy(policy);
  const packs = validateCatalog(manifests, normalizedPolicy);

  function validate(profile) {
    return validateProfile(profile, packs, normalizedPolicy);
  }

  function activate(profile, packId) {
    const current = validate(profile);
    if (typeof packId !== "string" || !packs.has(packId)) {
      fail("UNKNOWN_PACK", `Unknown equipment pack ${String(packId)}.`, { packId });
    }
    if (current.profile.packs.includes(packId)) {
      return { profile: current.profile, added: [] };
    }

    const additions = [];
    const added = new Set(current.profile.packs);
    function addWithDependencies(id) {
      if (added.has(id)) return;
      const pack = packs.get(id);
      for (const dependency of pack.requires) addWithDependencies(dependency);
      added.add(id);
      additions.push(id);
    }
    addWithDependencies(packId);

    const candidate = {
      version: PROFILE_VERSION,
      packs: [...current.profile.packs, ...additions],
    };
    const result = validate(candidate);
    return { profile: result.profile, added: additions };
  }

  function deactivate(profile, packId) {
    const current = validate(profile);
    if (typeof packId !== "string" || !packs.has(packId)) {
      fail("UNKNOWN_PACK", `Unknown equipment pack ${String(packId)}.`, { packId });
    }
    if (!current.profile.packs.includes(packId)) {
      return { profile: current.profile, removed: [] };
    }

    const dependents = current.packs
      .filter((pack) => pack.id !== packId && pack.requires.includes(packId))
      .map((pack) => pack.id);
    if (dependents.length > 0) {
      fail("PACK_IN_USE", `Pack ${packId} is required by active pack(s): ${dependents.join(", ")}.`, {
        packId,
        dependents,
      });
    }

    const candidate = {
      version: PROFILE_VERSION,
      packs: current.profile.packs.filter((id) => id !== packId),
    };
    const result = validate(candidate);
    return { profile: result.profile, removed: [packId] };
  }

  return Object.freeze({ validate, activate, deactivate });
}
