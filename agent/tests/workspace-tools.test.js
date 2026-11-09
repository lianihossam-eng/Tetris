import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceTools } from "../src/tools/workspace.js";

async function withWorkspace(run) {
  const parent = await mkdtemp(join(tmpdir(), "tetris-workspace-"));
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    await run({ parent, workspace, outside });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function toolsFor(workspace, options) {
  const tools = await createWorkspaceTools(workspace, options);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("reads and atomically writes files inside the workspace", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tools = await toolsFor(workspace);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "input.txt"), "before\n", "utf8");

    const read = await tools.get("read_file").execute({ path: "src/input.txt" }, {});
    assert.equal(read.content, "before\n");

    await tools.get("write_file").execute({ path: "new/nested.txt", content: "created\n" }, {});
    assert.equal(await readFile(join(workspace, "new", "nested.txt"), "utf8"), "created\n");
    assert.deepEqual(await readdir(join(workspace, "new")), ["nested.txt"]);
  });
});

test("reads selected line ranges and caps context output", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tools = await toolsFor(workspace);
    await writeFile(join(workspace, "lines.txt"), "one\ntwo\nthree\nfour\nfive", "utf8");
    await writeFile(join(workspace, "large.txt"), "x".repeat(70_000), "utf8");

    const range = await tools.get("read_file").execute({
      path: "lines.txt",
      start_line: 2,
      line_count: 2,
    }, {});
    assert.equal(range.content, "two\nthree");
    assert.equal(range.startLine, 2);
    assert.equal(range.endLine, 3);
    assert.equal(range.totalLines, 5);
    assert.equal(range.truncated, true);

    const large = await tools.get("read_file").execute({ path: "large.txt" }, {});
    assert.equal(large.bytes, 64 * 1024);
    assert.equal(large.truncated, true);
  });
});

test("rejects traversal and outside-pointing symlinks", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    const tools = await toolsFor(workspace);
    await writeFile(join(outside, "secret.txt"), "private", "utf8");
    await writeFile(join(workspace, "inside.txt"), "inside", "utf8");
    await symlink(join(workspace, "inside.txt"), join(workspace, "inside-link.txt"), "file");
    const throughLink = await tools.get("read_file").execute({ path: "inside-link.txt" }, {});
    assert.equal(throughLink.path, "inside.txt");
    assert.equal(throughLink.content, "inside");
    assert.equal(throughLink.bytes, 6);
    await assert.rejects(
      tools.get("write_file").execute({ path: "inside-link.txt", content: "changed" }, {}),
      { code: "SYMLINK_NOT_ALLOWED" },
    );
    await symlink(outside, join(workspace, "escape"), "dir");

    await assert.rejects(
      tools.get("read_file").execute({ path: "../outside/secret.txt" }, {}),
      { code: "PATH_OUTSIDE_WORKSPACE" },
    );
    await assert.rejects(
      tools.get("read_file").execute({ path: "escape/secret.txt" }, {}),
      { code: "PATH_OUTSIDE_WORKSPACE" },
    );
    await assert.rejects(
      tools.get("write_file").execute({ path: "../outside/secret.txt", content: "changed" }, {}),
      { code: "PATH_OUTSIDE_WORKSPACE" },
    );
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
  });
});

test("edits only one exact occurrence and leaves ambiguous files unchanged", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tools = await toolsFor(workspace);
    const file = join(workspace, "edit.txt");
    await writeFile(file, "same\nsame\n", "utf8");

    await assert.rejects(
      tools.get("edit_file").execute({ path: "edit.txt", old_string: "same", new_string: "changed" }, {}),
      { code: "AMBIGUOUS_EDIT" },
    );
    assert.equal(await readFile(file, "utf8"), "same\nsame\n");

    await tools.get("edit_file").execute({ path: "edit.txt", old_string: "same\nsame", new_string: "changed" }, {});
    assert.equal(await readFile(file, "utf8"), "changed\n");
  });
});

test("glob and literal grep skip generated directories and enforce result limits", async () => {
  await withWorkspace(async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "lib"), { recursive: true });
    await writeFile(join(workspace, "src", "a.js"), "first\nneedle here\n", "utf8");
    await writeFile(join(workspace, "src", "b.js"), "needle there\n", "utf8");
    await writeFile(join(workspace, "node_modules", "lib", "ignored.js"), "needle\n", "utf8");

    const tools = await toolsFor(workspace, { maxResults: 1 });
    const listing = await tools.get("glob_files").execute({ pattern: "src/**/*.js" }, {});
    assert.deepEqual(listing.paths, ["src/a.js"]);
    assert.equal(listing.truncated, true);

    const search = await tools.get("grep_files").execute({ pattern: "src/**/*.js", query: "needle" }, {});
    assert.deepEqual(search.matches, [{ path: "src/a.js", line: 2, text: "needle here", lineTruncated: false }]);
    assert.equal(search.truncated, true);
  });
});

test("rejects glob patterns that can escape the workspace", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tools = await toolsFor(workspace);

    await assert.rejects(
      tools.get("glob_files").execute({ pattern: "../**/*" }, {}),
      { code: "INVALID_PATTERN" },
    );
  });
});
