import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ToolError, requireObject, requireString, throwIfAborted } from "./errors.js";

const MAX_QUESTION_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function killProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

function runCraftCli(command, args, { cwd, signal, timeoutMs, maxOutputBytes }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolveResult, rejectResult) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let abortError;
    let timeout;
    let killTimeout;
    let pendingSignal;
    let settled = false;

    function capture(target, chunk) {
      const available = maxOutputBytes - bytes;
      if (available <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, available);
      target.push(captured);
      bytes += captured.length;
      if (captured.length < chunk.length) truncated = true;
    }

    function terminate(signalName) {
      if (child.pid === undefined) {
        pendingSignal = signalName;
        return;
      }
      killProcess(child, signalName);
      if (killTimeout === undefined) {
        killTimeout = setTimeout(() => killProcess(child, "SIGKILL"), 1_000);
        killTimeout.unref?.();
      }
    }

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      abortError = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      terminate("SIGTERM");
    }

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("spawn", () => {
      if (pendingSignal !== undefined) {
        const signalName = pendingSignal;
        pendingSignal = undefined;
        terminate(signalName);
      }
    });
    child.once("error", (error) => {
      cleanup();
      if (error.code === "ENOENT") {
        rejectResult(new ToolError("CRAFT_NOT_INSTALLED", `Craft Anything CLI is not available: ${command}.`, { cause: error }));
      } else {
        rejectResult(new ToolError("CRAFT_FAILED", `Craft Anything CLI could not start: ${error.message}`, { cause: error }));
      }
    });
    child.once("close", (exitCode, signalName) => {
      cleanup();
      if (abortError) {
        rejectResult(abortError);
        return;
      }
      if (timedOut) {
        rejectResult(new ToolError("CRAFT_TIMEOUT", `Craft Anything CLI exceeded ${timeoutMs} ms.`));
        return;
      }
      const result = {
        exitCode,
        signal: signalName,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      };
      if (exitCode !== 0) {
        rejectResult(new ToolError("CRAFT_FAILED", `Craft Anything CLI exited with ${exitCode ?? signalName}: ${result.stderr.slice(0, 4_000)}`));
        return;
      }
      resolveResult(result);
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, timeoutMs);
    timeout.unref?.();
  });
}

async function resolveTarget(workspaceRoot, input) {
  if (input === undefined) return workspaceRoot;
  const value = requireString(input, "target", { maxLength: 4_096 }).replaceAll("\\", "/");
  if (value.startsWith("/")
    || /^[a-zA-Z]:/.test(value)
    || value.includes("\0")
    || value.split("/").some((segment) => segment === "..")) {
    throw new ToolError("INVALID_TARGET", "Craft targets must be relative to the workspace.");
  }

  const candidate = resolve(workspaceRoot, value);
  const actual = await realpath(candidate).catch((error) => {
    if (error.code === "ENOENT") throw new ToolError("INVALID_TARGET", `Craft target does not exist: ${value}.`, { cause: error });
    throw error;
  });
  const fromRoot = relative(workspaceRoot, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ToolError("INVALID_TARGET", "Craft target resolves outside the workspace.");
  }
  return actual;
}

export async function createCraftTools({
  workspaceRoot,
  stateDirectory,
  command = "craft-anything-cli",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0
    || typeof stateDirectory !== "string" || stateDirectory.length === 0
    || typeof command !== "string" || command.length === 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new ToolError("INVALID_CONFIGURATION", "Craft tools need workspace, state, command, and positive limits.");
  }

  const root = await realpath(resolve(workspaceRoot));
  if (!(await stat(root)).isDirectory()) {
    throw new ToolError("INVALID_CONFIGURATION", "Craft workspace must be a directory.");
  }
  const projectDirectory = resolve(stateDirectory, "craft");
  const projectPath = join(projectDirectory, "project.cany");
  const reportDirectory = join(projectDirectory, "reports");

  const chat = {
    name: "craft_chat",
    description: "Ask the installed Craft Anything app to investigate the workspace. Deep read-only mode is enabled; code execution is not approved.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_LENGTH },
        target: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["question"],
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input, { signal } = {}) {
      requireObject(input, "craft_chat");
      const question = requireString(input.question, "question", { maxLength: MAX_QUESTION_LENGTH });
      const target = await resolveTarget(root, input.target);
      throwIfAborted(signal);
      await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
      const result = await runCraftCli(command, [
        "chat",
        "--format", "md",
        "--project", projectPath,
        "--target", target,
        "--deep",
        "--", question,
      ], { cwd: root, signal, timeoutMs, maxOutputBytes });
      return { answer: result.stdout, truncated: result.truncated };
    },
  };

  const report = {
    name: "craft_report",
    description: "Generate a Markdown evidence report with Craft Anything for a workspace target; output is stored in private agent state.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 4_096 } },
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input = {}, { signal } = {}) {
      requireObject(input, "craft_report");
      if (Object.keys(input).some((key) => key !== "target")) {
        throw new ToolError("INVALID_INPUT", "craft_report accepts only an optional target.");
      }
      const target = await resolveTarget(root, input.target);
      throwIfAborted(signal);
      await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
      const outputPath = join(reportDirectory, `${Date.now()}-${randomUUID()}.md`);
      await runCraftCli(command, [
        "report",
        "--format", "md",
        "--project", projectPath,
        "--out", outputPath,
        "--deep",
        target,
      ], { cwd: root, signal, timeoutMs, maxOutputBytes });
      const content = await readFile(outputPath, "utf8");
      if (Buffer.byteLength(content) > MAX_REPORT_BYTES) {
        throw new ToolError("CRAFT_REPORT_TOO_LARGE", `Craft report exceeds the ${MAX_REPORT_BYTES}-byte limit.`);
      }
      return { path: outputPath, report: content };
    },
  };

  return [chat, report];
}
