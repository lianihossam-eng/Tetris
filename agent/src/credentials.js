import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CREDENTIAL_FILE_BYTES = 128 * 1024;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class CredentialError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CredentialError";
    this.code = code;
  }
}

export function getAgentPaths({ env = process.env, home = homedir() } = {}) {
  const configHome = resolve(env.XDG_CONFIG_HOME || join(home, ".config"));
  const dataHome = resolve(env.XDG_DATA_HOME || join(home, ".local", "share"));
  const configDirectory = join(configHome, "tetris-agent");
  const dataDirectory = join(dataHome, "tetris-agent");
  return {
    configDirectory,
    dataDirectory,
    credentialsFile: join(configDirectory, "credentials.json"),
    profileFile: resolve(env.TETRIS_PROFILE || join(configDirectory, "profile.json")),
    defaultProfileFile: join(PACKAGE_ROOT, "profile.json"),
    equipmentDirectory: join(PACKAGE_ROOT, "equipment"),
    skillsDirectory: join(PACKAGE_ROOT, "equipment", "skills"),
    sessionsDirectory: join(dataDirectory, "sessions"),
  };
}

function normalizeCredentials(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const accessToken = value.accessToken ?? value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 16_384) return null;

  const credentials = { accessToken };
  const refreshToken = value.refreshToken ?? value.refresh_token;
  if (refreshToken !== undefined) {
    if (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > 16_384) return null;
    credentials.refreshToken = refreshToken;
  }
  const accountId = value.accountId ?? value.account_id;
  if (accountId !== undefined) {
    if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 4_096) return null;
    credentials.accountId = accountId;
  }
  const expiresAt = value.expiresAt ?? value.expires_at_ms ?? value.expires_at;
  if (expiresAt !== undefined) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return null;
    credentials.expiresAt = expiresAt;
  }
  return credentials;
}

async function readCredentialFile(filePath, source) {
  let details;
  try {
    details = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new CredentialError("INVALID_CREDENTIALS", `Credential file ${source} must be a regular file no larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CredentialError("INVALID_CREDENTIALS", `Credential file ${source} is not valid JSON.`, { cause: error });
    }
    throw error;
  }
  const credentials = normalizeCredentials(parsed);
  if (!credentials) {
    throw new CredentialError("INVALID_CREDENTIALS", `Credential file ${source} has an unsupported format.`);
  }
  return { credentials, source, path: filePath };
}

export async function loadCodexCredentials({
  tetrisCredentialsPath = getAgentPaths().credentialsFile,
} = {}) {
  return readCredentialFile(tetrisCredentialsPath, "tetris");
}

export async function saveTetrisCredentials(value, filePath = getAgentPaths().credentialsFile) {
  const credentials = normalizeCredentials(value);
  if (!credentials) {
    throw new CredentialError("INVALID_CREDENTIALS", "Refusing to save unsupported Codex credentials.");
  }

  const target = resolve(filePath);
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let handle;
  let created = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    created = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
  return credentials;
}

export function createCredentialRefreshLock() {
  const queues = new Map();
  return async ({ provider }, refresh) => {
    if (typeof refresh !== "function") {
      throw new TypeError("credential refresh lock requires a refresh callback");
    }
    const previous = queues.get(provider) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    queues.set(provider, current);
    await previous;
    try {
      return await refresh();
    } finally {
      release();
      if (queues.get(provider) === current) queues.delete(provider);
    }
  };
}
