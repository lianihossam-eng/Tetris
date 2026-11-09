import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createShellTool, createTerminalShellApproval } from "../src/tools/shell.js";

async function withWorkspace(run) {
  const workspace = await mkdtemp(join(tmpdir(), "tetris-shell-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function nodeCommand(code) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

test("requires explicit approval before running a shell command", async () => {
  await withWorkspace(async (workspace) => {
    let approvedCommand;
    const tool = await createShellTool(workspace, {
      approve: async (command) => {
        approvedCommand = command;
        return false;
      },
    });
    const command = nodeCommand("process.exit(0)");

    await assert.rejects(tool.execute({ command }, {}), { code: "SHELL_NOT_APPROVED" });
    assert.equal(approvedCommand, command);
  });
});

test("runs an approved command in the workspace and bounds captured output", async () => {
  await withWorkspace(async (workspace) => {
    const tool = await createShellTool(workspace, {
      approve: async () => true,
      maxOutputBytes: 128,
    });

    const result = await tool.execute({
      command: nodeCommand("process.stdout.write(process.cwd() + ':' + 'x'.repeat(1024))"),
    }, {});

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.slice(0, workspace.length), workspace);
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 128);
    assert.equal(result.truncated, true);
  });
});

test("terminates a command when its bounded timeout expires", async () => {
  await withWorkspace(async (workspace) => {
    const tool = await createShellTool(workspace, {
      approve: async () => true,
      defaultTimeoutMs: 2_000,
    });

    const result = await tool.execute({
      command: nodeCommand("setTimeout(() => {}, 5000)"),
      timeout_ms: 50,
    }, {});

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });
});

test("aborts an approved command when the turn signal is cancelled", async () => {
  await withWorkspace(async (workspace) => {
    const tool = await createShellTool(workspace, { approve: async () => true });
    const controller = new AbortController();
    const running = tool.execute({
      command: nodeCommand("setTimeout(() => {}, 5000)"),
    }, { signal: controller.signal });

    setTimeout(() => controller.abort(new Error("turn cancelled")), 50);
    await assert.rejects(running, /turn cancelled/);
  });
});

test("terminal shell approval renders readable prompts and accepts oui", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let displayed = "";
  output.on("data", (chunk) => {
    displayed += chunk.toString();
  });

  const approval = createTerminalShellApproval({ input, output });
  const pending = approval("printf safe", { workspaceRoot: "/workspace", timeoutMs: 1_000 });
  input.write("oui\n");

  assert.equal(await pending, true);
  assert.match(displayed, /Autoriser cette commande shell/);
  assert.doesNotMatch(displayed, /\\n/);
});
