import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ToolError, requireObject, requireString } from "./errors.js";

const TODO_VERSION = 1;
const MAX_TODO_TEXT = 2_000;
const TODO_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function normalizeText(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function emptyState() {
  return { version: TODO_VERSION, items: [] };
}

function validateState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.version !== TODO_VERSION
    || !Array.isArray(value.items)) {
    throw new ToolError("INVALID_TODO_STATE", "The saved todo list has an unsupported format.");
  }

  const ids = new Set();
  const items = value.items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string"
      || !TODO_ID_PATTERN.test(item.id)
      || typeof item.text !== "string"
      || item.text.trim().length === 0
      || item.text.length > MAX_TODO_TEXT
      || !["pending", "done"].includes(item.status)
      || typeof item.createdAt !== "string"
      || (item.completedAt !== null && typeof item.completedAt !== "string")) {
      throw new ToolError("INVALID_TODO_STATE", "The saved todo list contains an invalid item.");
    }
    if (ids.has(item.id)) throw new ToolError("INVALID_TODO_STATE", "The saved todo list contains duplicate ids.");
    ids.add(item.id);
    return { ...item };
  });

  return { version: TODO_VERSION, items };
}

function sessionKey(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ToolError("TODO_SESSION_REQUIRED", "Todo actions need an active Fx session.");
  }
  return createHash("sha256").update(sessionId).digest("hex");
}

async function readState(filePath) {
  let serialized;
  try {
    serialized = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }

  try {
    return validateState(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("INVALID_TODO_STATE", "The saved todo list is not valid JSON.", { cause: error });
  }
}

async function writeState(filePath, state) {
  const directory = resolve(filePath, "..");
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    created = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

function serializeBySession(locks, key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tail = current.then(() => undefined, () => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return current;
}

function ensureFields(input, allowed) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ToolError("INVALID_INPUT", "Todo input contains unsupported fields.");
  }
}

export function createTodoTool(stateDirectory) {
  if (typeof stateDirectory !== "string" || stateDirectory.length === 0) {
    throw new ToolError("INVALID_CONFIGURATION", "Todo tool needs a state directory.");
  }
  const directory = resolve(stateDirectory, "todos");
  const locks = new Map();

  return {
    name: "todo",
    description: "Manage a persistent, session-scoped task list. Duplicate active task text is kept as one item.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "complete", "remove"] },
        text: { type: "string", minLength: 1, maxLength: MAX_TODO_TEXT },
        id: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input, context = {}) {
      requireObject(input, "todo");
      const action = input.action;
      if (!["list", "add", "complete", "remove"].includes(action)) {
        throw new ToolError("INVALID_INPUT", "action must be list, add, complete, or remove.");
      }
      const key = sessionKey(context.sessionId);
      const filePath = join(directory, `${key}.json`);

      return serializeBySession(locks, key, async () => {
        const state = await readState(filePath);
        if (action === "list") {
          ensureFields(input, ["action"]);
          return { items: state.items };
        }

        if (action === "add") {
          ensureFields(input, ["action", "text"]);
          const text = requireString(input.text, "text", { maxLength: MAX_TODO_TEXT }).trim().replace(/\s+/g, " ");
          const normalized = normalizeText(text);
          const duplicate = state.items.find((item) => item.status === "pending" && normalizeText(item.text) === normalized);
          if (duplicate) return { added: false, duplicateOf: duplicate.id, items: state.items };
          const item = {
            id: randomUUID(),
            text,
            status: "pending",
            createdAt: new Date().toISOString(),
            completedAt: null,
          };
          state.items.push(item);
          await writeState(filePath, state);
          return { added: true, item, items: state.items };
        }

        ensureFields(input, ["action", "id"]);
        const id = requireString(input.id, "id", { maxLength: 64 });
        const itemIndex = state.items.findIndex((item) => item.id === id);
        if (itemIndex === -1) throw new ToolError("TODO_NOT_FOUND", `Todo item ${id} does not exist.`);

        if (action === "complete") {
          const item = state.items[itemIndex];
          if (item.status === "pending") {
            item.status = "done";
            item.completedAt = new Date().toISOString();
            await writeState(filePath, state);
          }
          return { item, items: state.items };
        }

        const [item] = state.items.splice(itemIndex, 1);
        await writeState(filePath, state);
        return { removed: item, items: state.items };
      });
    },
  };
}
