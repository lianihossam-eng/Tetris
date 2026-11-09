import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class ProfileError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProfileError";
    this.code = code;
  }
}

function requireRegistry(registry) {
  if (!registry || typeof registry.validate !== "function") {
    throw new TypeError("profile operations require an equipment registry");
  }
}

function requirePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("profile path must be a non-empty string");
  }
  return resolve(filePath);
}

export async function loadProfile(filePath, { registry, defaultProfile } = {}) {
  requireRegistry(registry);
  const target = requirePath(filePath);

  let contents;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (defaultProfile === undefined) {
      throw new ProfileError("PROFILE_NOT_FOUND", `Profile file not found: ${target}.`, { cause: error });
    }
    return registry.validate(defaultProfile).profile;
  }

  let profile;
  try {
    profile = JSON.parse(contents);
  } catch (error) {
    throw new ProfileError("INVALID_PROFILE_JSON", `Profile file is not valid JSON: ${target}.`, { cause: error });
  }

  return registry.validate(profile).profile;
}

export async function saveProfileAtomically(filePath, profile, { registry } = {}) {
  requireRegistry(registry);
  const target = requirePath(filePath);
  const validatedProfile = registry.validate(profile).profile;
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(validatedProfile, null, 2)}\n`;

  await mkdir(directory, { recursive: true, mode: 0o700 });

  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    temporaryCreated = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporaryCreated) await unlink(temporary).catch(() => {});
    throw error;
  }

  return validatedProfile;
}
