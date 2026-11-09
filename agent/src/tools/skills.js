import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ToolError, requireObject, requireString } from "./errors.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 32;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isInside(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function validateSkillRecord(skill) {
  if (skill === null || typeof skill !== "object" || Array.isArray(skill)
    || typeof skill.id !== "string"
    || !ID_PATTERN.test(skill.id)
    || typeof skill.name !== "string"
    || skill.name.trim().length === 0
    || typeof skill.description !== "string"
    || skill.description.trim().length === 0
    || typeof skill.file !== "string"
    || skill.file.length === 0) {
    throw new ToolError("INVALID_SKILLS", "Every active skill needs an id, name, description, and relative file.");
  }

  const file = skill.file.replaceAll("\\", "/");
  if (file.startsWith("/")
    || /^[a-zA-Z]:/.test(file)
    || file.includes("\0")
    || file.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw new ToolError("INVALID_SKILLS", `Skill ${skill.id} has a path outside the installed skills directory.`);
  }
  return { id: skill.id, name: skill.name, description: skill.description, file };
}

async function readSkillFile(root, file, maxBytes) {
  const target = resolve(root, file);
  if (!isInside(root, target)) {
    throw new ToolError("INVALID_SKILLS", `Skill file escapes the installed skills directory: ${file}.`);
  }

  const actual = await realpath(target);
  if (!isInside(root, actual)) {
    throw new ToolError("INVALID_SKILLS", `Skill file resolves outside the installed skills directory: ${file}.`);
  }
  if (actual !== target) {
    throw new ToolError("INVALID_SKILLS", `Skill files cannot be symbolic links: ${file}.`);
  }

  const details = await stat(actual);
  if (!details.isFile()) throw new ToolError("INVALID_SKILLS", `Skill path is not a file: ${file}.`);
  if (details.size > maxBytes) {
    throw new ToolError("SKILL_TOO_LARGE", `Skill file exceeds the ${maxBytes}-byte instruction budget: ${file}.`);
  }

  const contents = await readFile(actual, "utf8");
  if (Buffer.byteLength(contents) > maxBytes) {
    throw new ToolError("SKILL_TOO_LARGE", `Skill file exceeds the ${maxBytes}-byte instruction budget: ${file}.`);
  }
  return contents;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function skillRelativePath(root, target) {
  return relative(root, target).split(sep).join("/");
}

export async function createSkillTool(activeSkills, skillsRoot, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  if (!Array.isArray(activeSkills)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new ToolError("INVALID_SKILLS", "Skill tool needs active skill records and positive file limits.");
  }
  if (typeof skillsRoot !== "string" || skillsRoot.length === 0) {
    throw new ToolError("INVALID_SKILLS", "Skill tool needs an installed skills directory.");
  }

  const root = await realpath(resolve(skillsRoot));
  if (!(await stat(root)).isDirectory()) {
    throw new ToolError("INVALID_SKILLS", "Installed skills path must be a directory.");
  }

  const skills = new Map();
  for (const rawSkill of activeSkills) {
    const skill = validateSkillRecord(rawSkill);
    if (skills.has(skill.id)) {
      throw new ToolError("INVALID_SKILLS", `Active skill ${skill.id} is listed more than once.`);
    }
    skills.set(skill.id, skill);
  }

  const available = [...skills.values()]
    .sort((left, right) => compareNames(left.id, right.id))
    .map(({ id, name, description }) => `${id}: ${name} — ${description}`)
    .join("\n");

  return {
    name: "skill",
    description: `Load full instructions and local references for one active skill. Available skills:\n${available || "none"}`,
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["skill_id"],
      additionalProperties: false,
    },
    idempotent: true,
    writes: false,
    async execute(input) {
      requireObject(input, "skill");
      const skillId = requireString(input.skill_id, "skill_id", { maxLength: 64 });
      const skill = skills.get(skillId);
      if (!skill) throw new ToolError("SKILL_NOT_ACTIVE", `Skill ${skillId} is not active in this equipment profile.`);

      let totalBytes = 0;
      const files = [];
      const main = await readSkillFile(root, skill.file, maxBytes);
      totalBytes += Buffer.byteLength(main);
      files.push({ path: skill.file, content: main });

      const skillDirectory = dirname(resolve(root, skill.file));
      const mainPath = resolve(root, skill.file);
      const siblingEntries = await readdir(skillDirectory, { withFileTypes: true });
      const referencePaths = siblingEntries
        .filter((entry) => entry.isFile()
          && entry.name.endsWith(".md")
          && resolve(skillDirectory, entry.name) !== mainPath)
        .map((entry) => {
          const directoryPath = skillRelativePath(root, skillDirectory);
          return directoryPath ? `${directoryPath}/${entry.name}` : entry.name;
        });
      const referencesDirectory = resolve(skillDirectory, "references");
      let references = [];
      try {
        references = await readdir(referencesDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const entry of references) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        referencePaths.push(`${skillRelativePath(root, referencesDirectory)}/${entry.name}`);
      }
      referencePaths.sort(compareNames);
      if (files.length + referencePaths.length > maxFiles) {
        throw new ToolError("SKILL_TOO_MANY_FILES", `Skill ${skillId} exceeds the ${maxFiles}-file load limit.`);
      }

      for (const referencePath of referencePaths) {
        const content = await readSkillFile(root, referencePath, maxBytes - totalBytes);
        totalBytes += Buffer.byteLength(content);
        files.push({ path: referencePath, content });
      }

      const instructions = files.map(({ path, content }) => `<!-- ${path} -->\n${content}`).join("\n\n");
      return {
        skill_id: skill.id,
        name: skill.name,
        instructions,
        files: files.map(({ path }) => path),
        bytes: totalBytes,
      };
    },
  };
}
