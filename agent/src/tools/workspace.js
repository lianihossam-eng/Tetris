import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { ToolError, requireObject, requireString, throwIfAborted } from "./errors.js";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_SCAN_ENTRIES = 25_000;
const DEFAULT_MAX_SEARCH_FILES = 1_000;
const MAX_GLOB_LENGTH = 256;
const MAX_QUERY_LENGTH = 512;
const MAX_GREP_LINE_LENGTH = 4_000;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;
const MAX_READ_OUTPUT_BYTES = 64 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".tetris",
  ".turbo",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
  "zig-cache",
  "zig-out",
  ".zig-cache",
]);

const objectSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function assertWithinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${path.sep}`)
    || isAbsolute(pathFromRoot)) {
    throw new ToolError("PATH_OUTSIDE_WORKSPACE", "The requested path resolves outside the workspace.");
  }
}

function normalizeRelativePath(input) {
  requireString(input, "path", { maxLength: 4096 });
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0")) {
    throw new ToolError("PATH_OUTSIDE_WORKSPACE", "Workspace tools accept relative paths only.");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new ToolError("PATH_OUTSIDE_WORKSPACE", "Workspace paths cannot contain parent-directory segments.");
  }
  return normalized;
}

function displayPath(root, target) {
  return relative(root, target).split(path.sep).join("/");
}

async function verifyExistingAncestor(root, target, rejectSymlinks) {
  let ancestor = target;
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      assertWithinRoot(root, resolvedAncestor);
      if (rejectSymlinks && ancestor !== resolvedAncestor) {
        throw new ToolError("SYMLINK_NOT_ALLOWED", "Workspace writes cannot traverse symbolic links.");
      }
      const resolvedTarget = resolve(resolvedAncestor, relative(ancestor, target));
      assertWithinRoot(root, resolvedTarget);
      return resolvedTarget;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function resolveWorkspacePath(root, input, { allowMissing = false, rejectSymlinks = false } = {}) {
  const normalized = normalizeRelativePath(input);
  const target = resolve(root, normalized);
  assertWithinRoot(root, target);
  if (target === root) {
    throw new ToolError("INVALID_PATH", "A workspace root directory is not a file path.");
  }

  try {
    const realTarget = await realpath(target);
    assertWithinRoot(root, realTarget);
    if (rejectSymlinks && target !== realTarget) {
      throw new ToolError("SYMLINK_NOT_ALLOWED", "Workspace writes cannot traverse symbolic links.");
    }
    return realTarget;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!allowMissing) {
      throw new ToolError("FILE_NOT_FOUND", `Workspace file not found: ${displayPath(root, target)}.`, { cause: error });
    }
    return verifyExistingAncestor(root, target, rejectSymlinks);
  }
}


async function readBoundedFile(target, maxBytes, signal) {
  throwIfAborted(signal);
  const chunks = [];
  let totalBytes = 0;
  const stream = createReadStream(target, { highWaterMark: 64 * 1024, signal });
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new ToolError("FILE_TOO_LARGE", `File exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw new ToolError("NOT_TEXT_FILE", "Binary files are not supported by this tool.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ToolError("NOT_TEXT_FILE", "File is not valid UTF-8 text.", { cause: error });
  }
}

async function assertRegularFile(target, { rejectSymlink = false } = {}) {
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() && rejectSymlink) {
    throw new ToolError("SYMLINK_NOT_ALLOWED", "Writing through a symbolic link is not allowed.");
  }
  const resolved = details.isSymbolicLink() ? await stat(target) : details;
  if (!resolved.isFile()) {
    throw new ToolError("NOT_REGULAR_FILE", "Workspace tools operate on regular files only.");
  }
  return { mode: details.mode & 0o777, symlink: details.isSymbolicLink() };
}

async function atomicWriteFile(target, content, mode, signal) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let temporaryCreated = false;
  try {
    throwIfAborted(signal);
    handle = await open(temporary, "wx", mode);
    temporaryCreated = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    await rename(temporary, target);
    temporaryCreated = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporaryCreated) await unlink(temporary).catch(() => {});
    throw error;
  }
}

function normalizeGlobPattern(value) {
  const pattern = requireString(value, "pattern", { maxLength: MAX_GLOB_LENGTH }).replaceAll("\\", "/");
  if (pattern.startsWith("/")
    || /^[a-zA-Z]:/.test(pattern)
    || pattern.includes("\0")
    || pattern.split("/").some((segment) => segment === "..")) {
    throw new ToolError("INVALID_PATTERN", "Glob patterns must stay inside the workspace.");
  }
  return pattern;
}

function normalizeResultLimit(value, maximum) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ToolError("INVALID_INPUT", "max_results must be a positive integer.");
  }
  return Math.min(value, maximum);
}
function ensureFields(input, allowed, toolName) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ToolError("INVALID_INPUT", `${toolName} input contains unsupported fields.`);
  }
}

function readLineWindow(content, startLine, lineCount) {
  const lines = content.split("\n");
  const firstLine = startLine - 1;
  const selected = lines.slice(firstLine, firstLine + lineCount);
  let output = selected.join("\n");
  let truncated = firstLine + selected.length < lines.length;
  if (Buffer.byteLength(output) > MAX_READ_OUTPUT_BYTES) {
    output = new TextDecoder("utf-8").decode(Buffer.from(output, "utf8").subarray(0, MAX_READ_OUTPUT_BYTES));
    truncated = true;
  }
  return {
    content: output,
    bytes: Buffer.byteLength(output),
    startLine,
    endLine: selected.length === 0 ? null : firstLine + selected.length,
    totalLines: lines.length,
    truncated,
  };
}

async function walkMatchingFiles(root, pattern, maxMatches, maxScanEntries, signal) {
  const matches = [];
  let scanned = 0;
  let truncated = false;

  async function walk(directory) {
    throwIfAborted(signal);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      throwIfAborted(signal);
      scanned += 1;
      if (scanned > maxScanEntries) {
        truncated = true;
        return true;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (await walk(resolve(directory, entry.name))) return true;
        continue;
      }
      if (!entry.isFile()) continue;

      const absolutePath = resolve(directory, entry.name);
      const relativePath = displayPath(root, absolutePath);
      if (!path.matchesGlob(relativePath, pattern)) continue;
      if (matches.length === maxMatches) {
        truncated = true;
        return true;
      }
      matches.push(relativePath);
    }
    return false;
  }

  await walk(root);
  return { matches, truncated, scanned };
}

function schemaProperties() {
  return {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    pattern: { type: "string", minLength: 1, maxLength: MAX_GLOB_LENGTH },
    query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
    max_results: { type: "integer", minimum: 1 },
    case_sensitive: { type: "boolean" },
    start_line: { type: "integer", minimum: 1 },
    line_count: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
  };
}

export async function createWorkspaceTools(workspaceRoot, {
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxResults = DEFAULT_MAX_RESULTS,
  maxSearchFiles = DEFAULT_MAX_SEARCH_FILES,
  maxScanEntries = DEFAULT_MAX_SCAN_ENTRIES,
} = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new ToolError("INVALID_WORKSPACE", "Workspace root must be a non-empty path.");
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
    || !Number.isSafeInteger(maxResults) || maxResults < 1
    || !Number.isSafeInteger(maxSearchFiles) || maxSearchFiles < 1
    || !Number.isSafeInteger(maxScanEntries) || maxScanEntries < 1) {
    throw new ToolError("INVALID_CONFIGURATION", "Workspace tool limits must be positive integers.");
  }

  const root = await realpath(resolve(workspaceRoot));
  if (!(await stat(root)).isDirectory()) {
    throw new ToolError("INVALID_WORKSPACE", "Workspace root must be a directory.");
  }

  const readFileTool = {
    name: "read_file",
    description: `Read a UTF-8 workspace file by line range. Output is capped at ${MAX_READ_OUTPUT_BYTES} bytes; use start_line for later sections.`,
    inputSchema: objectSchema({
      path: schemaProperties().path,
      start_line: schemaProperties().start_line,
      line_count: schemaProperties().line_count,
    }, ["path"]),
    idempotent: true,
    writes: false,
    async execute(input, { signal } = {}) {
      requireObject(input, "read_file");
      ensureFields(input, ["path", "start_line", "line_count"], "read_file");
      const startLine = input.start_line ?? 1;
      const lineCount = input.line_count ?? DEFAULT_READ_LINES;
      if (!Number.isSafeInteger(startLine) || startLine < 1
        || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_READ_LINES) {
        throw new ToolError("INVALID_INPUT", `start_line must be positive and line_count must be between 1 and ${MAX_READ_LINES}.`);
      }
      const target = await resolveWorkspacePath(root, input.path);
      await assertRegularFile(target);
      const content = decodeText(await readBoundedFile(target, maxFileBytes, signal));
      return { path: displayPath(root, target), ...readLineWindow(content, startLine, lineCount) };
    },
  };

  const writeFileTool = {
    name: "write_file",
    description: `Write a UTF-8 file inside the workspace atomically (maximum ${maxFileBytes} bytes).`,
    inputSchema: objectSchema({
      path: schemaProperties().path,
      content: { type: "string", maxLength: maxFileBytes },
    }, ["path", "content"]),
    idempotent: false,
    writes: true,
    async execute(input, { signal } = {}) {
      requireObject(input, "write_file");
      requireString(input.content, "content", { maxLength: maxFileBytes, allowEmpty: true });
      const contentBytes = Buffer.byteLength(input.content);
      if (contentBytes > maxFileBytes) {
        throw new ToolError("FILE_TOO_LARGE", `Content exceeds the ${maxFileBytes}-byte limit.`);
      }

      let target = await resolveWorkspacePath(root, input.path, { allowMissing: true, rejectSymlinks: true });
      await mkdir(dirname(target), { recursive: true });
      target = await resolveWorkspacePath(root, input.path, { allowMissing: true, rejectSymlinks: true });
      const existing = await assertRegularFile(target, { rejectSymlink: true });
      await atomicWriteFile(target, input.content, existing?.mode ?? 0o644, signal);
      return { path: displayPath(root, target), bytes: contentBytes, created: existing === null };
    },
  };

  const editFileTool = {
    name: "edit_file",
    description: "Replace one exact, unique text occurrence in a UTF-8 workspace file. The edit is atomic.",
    inputSchema: objectSchema({
      path: schemaProperties().path,
      old_string: { type: "string", minLength: 1, maxLength: maxFileBytes },
      new_string: { type: "string", maxLength: maxFileBytes },
    }, ["path", "old_string", "new_string"]),
    idempotent: false,
    writes: true,
    async execute(input, { signal } = {}) {
      requireObject(input, "edit_file");
      requireString(input.old_string, "old_string", { maxLength: maxFileBytes });
      requireString(input.new_string, "new_string", { maxLength: maxFileBytes, allowEmpty: true });
      const target = await resolveWorkspacePath(root, input.path, { rejectSymlinks: true });
      const existing = await assertRegularFile(target, { rejectSymlink: true });
      if (existing === null) throw new ToolError("FILE_NOT_FOUND", `Workspace file not found: ${displayPath(root, target)}.`);
      const current = decodeText(await readBoundedFile(target, maxFileBytes, signal));
      const first = current.indexOf(input.old_string);
      if (first === -1) throw new ToolError("EDIT_NOT_FOUND", "old_string was not found in the file.");
      if (current.indexOf(input.old_string, first + input.old_string.length) !== -1) {
        throw new ToolError("AMBIGUOUS_EDIT", "old_string must match exactly one occurrence in the file.");
      }

      const updated = `${current.slice(0, first)}${input.new_string}${current.slice(first + input.old_string.length)}`;
      const updatedBytes = Buffer.byteLength(updated);
      if (updatedBytes > maxFileBytes) {
        throw new ToolError("FILE_TOO_LARGE", `Edited file exceeds the ${maxFileBytes}-byte limit.`);
      }
      await atomicWriteFile(target, updated, existing.mode, signal);
      return { path: displayPath(root, target), bytes: updatedBytes, replacements: 1 };
    },
  };

  const globTool = {
    name: "glob_files",
    description: "List workspace files matching a relative glob; generated and dependency directories are excluded.",
    inputSchema: objectSchema({
      pattern: schemaProperties().pattern,
      max_results: schemaProperties().max_results,
    }, ["pattern"]),
    idempotent: true,
    writes: false,
    async execute(input, { signal } = {}) {
      requireObject(input, "glob_files");
      const pattern = normalizeGlobPattern(input.pattern);
      const limit = normalizeResultLimit(input.max_results, maxResults);
      return walkMatchingFiles(root, pattern, limit, maxScanEntries, signal).then(({ matches, truncated, scanned }) => ({
        paths: matches,
        truncated,
        scannedEntries: scanned,
      }));
    },
  };

  const grepTool = {
    name: "grep_files",
    description: `Search UTF-8 workspace files for a literal string; each file is limited to ${maxFileBytes} bytes.`,
    inputSchema: objectSchema({
      pattern: schemaProperties().pattern,
      query: schemaProperties().query,
      max_results: schemaProperties().max_results,
      case_sensitive: schemaProperties().case_sensitive,
    }, ["query"]),
    idempotent: true,
    writes: false,
    async execute(input, { signal } = {}) {
      requireObject(input, "grep_files");
      const query = requireString(input.query, "query", { maxLength: MAX_QUERY_LENGTH });
      const pattern = input.pattern === undefined ? "**/*" : normalizeGlobPattern(input.pattern);
      const limit = normalizeResultLimit(input.max_results, maxResults);
      if (input.case_sensitive !== undefined && typeof input.case_sensitive !== "boolean") {
        throw new ToolError("INVALID_INPUT", "case_sensitive must be a boolean.");
      }
      const needle = input.case_sensitive === false ? query.toLocaleLowerCase("en-US") : query;
      const files = await walkMatchingFiles(root, pattern, maxSearchFiles, maxScanEntries, signal);
      const matches = [];
      let skippedFiles = 0;
      let truncated = files.truncated;
      let filesScanned = 0;

      let stop = false;
      for (const relativePath of files.matches) {
        throwIfAborted(signal);
        filesScanned += 1;
        const target = await resolveWorkspacePath(root, relativePath);
        let content;
        try {
          content = decodeText(await readBoundedFile(target, maxFileBytes, signal));
        } catch (error) {
          if (error.code === "FILE_TOO_LARGE" || error.code === "NOT_TEXT_FILE") {
            skippedFiles += 1;
            continue;
          }
          throw error;
        }
        const lines = content.split("\n");
        for (const [index, line] of lines.entries()) {
          const haystack = input.case_sensitive === false ? line.toLocaleLowerCase("en-US") : line;
          if (!haystack.includes(needle)) continue;
          if (matches.length === limit) {
            truncated = true;
            stop = true;
            break;
          }
          matches.push({
            path: relativePath,
            line: index + 1,
            text: line.slice(0, MAX_GREP_LINE_LENGTH),
            lineTruncated: line.length > MAX_GREP_LINE_LENGTH,
          });
        }
        if (stop) break;
      }

      return { matches, truncated, filesScanned, skippedFiles };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
}
