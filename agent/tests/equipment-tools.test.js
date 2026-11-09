import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSkillTool } from "../src/tools/skills.js";
import { createTodoTool } from "../src/tools/todo.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-equipment-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("todo state is isolated by session, persisted, and deduplicates active items", async () => {
  await withTempDir(async (directory) => {
    const tool = createTodoTool(join(directory, "state"));
    const context = { sessionId: "session-a" };
    assert.deepEqual(await tool.execute({ action: "list" }, context), { items: [] });

    const added = await tool.execute({ action: "add", text: "  Check   dependency graph  " }, context);
    assert.equal(added.added, true);
    assert.equal(added.items[0].text, "Check dependency graph");

    const duplicate = await tool.execute({ action: "add", text: "check dependency graph" }, context);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.items.length, 1);

    await tool.execute({ action: "complete", id: added.items[0].id }, context);
    assert.equal((await tool.execute({ action: "list" }, context)).items[0].status, "done");
    assert.deepEqual(await tool.execute({ action: "list" }, { sessionId: "session-b" }), { items: [] });

    const reopened = createTodoTool(join(directory, "state"));
    assert.equal((await reopened.execute({ action: "list" }, context)).items[0].status, "done");
  });
});

test("todo mutations reject invalid session or unknown ids without changing state", async () => {
  await withTempDir(async (directory) => {
    const tool = createTodoTool(join(directory, "state"));
    await assert.rejects(tool.execute({ action: "list" }, {}), { code: "TODO_SESSION_REQUIRED" });
    await assert.rejects(
      tool.execute({ action: "complete", id: "missing" }, { sessionId: "session-a" }),
      { code: "TODO_NOT_FOUND" },
    );
    assert.deepEqual(await tool.execute({ action: "list" }, { sessionId: "session-a" }), { items: [] });
  });
});

test("skill tool loads one active skill and its references only on request", async () => {
  await withTempDir(async (directory) => {
    const skillsRoot = join(directory, "skills");
    await mkdir(join(skillsRoot, "review", "references"), { recursive: true });
    await mkdir(join(skillsRoot, "other"), { recursive: true });
    await writeFile(join(skillsRoot, "review", "SKILL.md"), "# Review\nUse the checklist and see [examples](examples.md).\n", "utf8");
    await writeFile(join(skillsRoot, "review", "examples.md"), "Example: assert the returned value.\n", "utf8");
    await writeFile(join(skillsRoot, "review", "references", "checklist.md"), "Check behavior and boundaries.\n", "utf8");
    await writeFile(join(skillsRoot, "other", "SKILL.md"), "PRIVATE INACTIVE SKILL\n", "utf8");

    const tool = await createSkillTool([
      { id: "review", name: "Code review", description: "Review changes", file: "review/SKILL.md" },
    ], skillsRoot);
    const loaded = await tool.execute({ skill_id: "review" }, {});

    assert.equal(loaded.name, "Code review");
    assert.match(loaded.instructions, /Check behavior and boundaries/);
    assert.match(loaded.instructions, /Example: assert the returned value/);
    assert.deepEqual(loaded.files, [
      "review/SKILL.md",
      "review/examples.md",
      "review/references/checklist.md",
    ]);
    assert.doesNotMatch(loaded.instructions, /PRIVATE INACTIVE SKILL/);
    await assert.rejects(tool.execute({ skill_id: "other" }, {}), { code: "SKILL_NOT_ACTIVE" });
  });
});

test("skill tool rejects a file that escapes its installed equipment directory", async () => {
  await withTempDir(async (directory) => {
    const skillsRoot = join(directory, "skills");
    await mkdir(skillsRoot);
    await writeFile(join(directory, "outside.md"), "outside", "utf8");

    await assert.rejects(
      createSkillTool([
        { id: "escape", name: "Escape", description: "Invalid path", file: "../outside.md" },
      ], skillsRoot),
      { code: "INVALID_SKILLS" },
    );
    assert.equal(await readFile(join(directory, "outside.md"), "utf8"), "outside");
  });
});
