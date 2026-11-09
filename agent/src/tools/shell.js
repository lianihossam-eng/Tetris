import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { resolve } from "node:path";

import { ToolError, requireObject, requireString, throwIfAborted } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 8_192;
const SECRET_ENV_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;

function sanitizedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENV_NAME.test(name)),
  );
}

function sendSignal(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

function runCommand(command, { cwd, signal, timeoutMs, maxOutputBytes, killGraceMs }) {
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const startedAt = Date.now();
  const child = spawn(shell, args, {
    cwd,
    env: sanitizedEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolveResult, rejectResult) => {
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let abortError;
    let settled = false;
    let timeout;
    let killTimeout;
    let pendingSignal;

    function capture(target, chunk) {
      const available = maxOutputBytes - capturedBytes;
      if (available <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, available);
      target.push(captured);
      capturedBytes += captured.length;
      if (captured.length < chunk.length) truncated = true;
    }

    function terminate(signalName) {
      if (child.pid === undefined) {
        pendingSignal = signalName;
        return;
      }
      sendSignal(child, signalName);
      if (killTimeout === undefined) {
        killTimeout = setTimeout(() => sendSignal(child, "SIGKILL"), killGraceMs);
        killTimeout.unref?.();
      }
    }

    function onAbort() {
      abortError = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      terminate("SIGTERM");
    }

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      signal?.removeEventListener("abort", onAbort);
    }

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.once("spawn", () => {
      if (pendingSignal !== undefined) {
        const signalName = pendingSignal;
        pendingSignal = undefined;
        terminate(signalName);
      }
    });
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      cleanup();
      rejectResult(new ToolError("SHELL_FAILED", `Could not start the shell command: ${error.message}`, { cause: error }));
    });
    child.once("close", (exitCode, signalName) => {
      cleanup();
      if (abortError) {
        rejectResult(abortError);
        return;
      }
      resolveResult({
        exitCode,
        signal: signalName,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
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

export function createTerminalShellApproval({ input = stdin, output = stderr } = {}) {
  return async (command, { workspaceRoot, timeoutMs }) => {
    if (!input.isTTY || !output.isTTY) return false;
    const prompt = createInterface({ input, output, terminal: true });
    try {
      const answer = await prompt.question(
        `Autoriser cette commande shell dans ${workspaceRoot} (non sandboxée, délai ${timeoutMs} ms)?\n${JSON.stringify(command)}\nTapez oui (ou yes) pour exécuter: `,
      );
      const confirmation = answer.trim().toLowerCase();
      return confirmation === "oui" || confirmation === "yes";
    } finally {
      prompt.close();
    }
  };
}

export async function createShellTool(workspaceRoot, {
  approve,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxTimeoutMs = MAX_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  killGraceMs = 1_000,
} = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new ToolError("INVALID_CONFIGURATION", "Shell tool needs a workspace directory.");
  }
  if (typeof approve !== "function") {
    throw new ToolError("INVALID_CONFIGURATION", "Shell tool needs an explicit approval callback.");
  }
  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs < 1
    || !Number.isSafeInteger(maxTimeoutMs) || maxTimeoutMs < defaultTimeoutMs
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1) {
    throw new ToolError("INVALID_CONFIGURATION", "Shell tool limits must be positive integers.");
  }

  const cwd = await realpath(resolve(workspaceRoot));
  if (!(await stat(cwd)).isDirectory()) {
    throw new ToolError("INVALID_CONFIGURATION", "Shell tool workspace must be a directory.");
  }

  return {
    name: "shell",
    description: "Run a shell command after user approval. The shell is not sandboxed and can access files outside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_LENGTH },
        timeout_ms: { type: "integer", minimum: 1, maximum: maxTimeoutMs },
      },
      required: ["command"],
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input, { signal } = {}) {
      requireObject(input, "shell");
      const command = requireString(input.command, "command", { maxLength: MAX_COMMAND_LENGTH });
      const timeoutMs = input.timeout_ms ?? defaultTimeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
        throw new ToolError("INVALID_INPUT", `timeout_ms must be between 1 and ${maxTimeoutMs}.`);
      }
      throwIfAborted(signal);
      if (!await approve(command, { workspaceRoot: cwd, timeoutMs })) {
        throw new ToolError("SHELL_NOT_APPROVED", "The user did not approve this shell command.");
      }
      throwIfAborted(signal);
      return runCommand(command, { cwd, signal, timeoutMs, maxOutputBytes, killGraceMs });
    },
  };
}
