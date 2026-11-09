import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { EquipmentError } from "./registry.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

function fail(code, message, details = {}) {
  throw new EquipmentError(code, message, details);
}

function ensureInside(root, target) {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail("INVALID_MANIFEST_PATH", "Equipment manifest resolves outside the equipment directory.");
  }
}

async function readManifestDirectory(equipmentRoot, directoryName) {
  const directory = resolve(equipmentRoot, directoryName);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const manifests = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail("INVALID_MANIFEST_PATH", `Equipment directory cannot contain symbolic links: ${entry.name}.`, { entry: entry.name });
    }
    if (!entry.isDirectory()) continue;

    const packageDirectory = resolve(directory, entry.name);
    const manifestPath = resolve(packageDirectory, "manifest.json");
    let actualPath;
    try {
      actualPath = await realpath(manifestPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        fail("MISSING_MANIFEST", `Equipment directory ${entry.name} is missing manifest.json.`, { entry: entry.name });
      }
      throw error;
    }
    ensureInside(equipmentRoot, actualPath);
    if (actualPath !== manifestPath) {
      fail("INVALID_MANIFEST_PATH", `Equipment manifest cannot be a symbolic link: ${entry.name}/manifest.json.`, { entry: entry.name });
    }

    const details = await stat(actualPath);
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) {
      fail("INVALID_MANIFEST", `Equipment manifest ${entry.name}/manifest.json must be a file no larger than ${MAX_MANIFEST_BYTES} bytes.`, { entry: entry.name });
    }

    let manifest;
    try {
      manifest = JSON.parse(await readFile(actualPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail("INVALID_MANIFEST_JSON", `Equipment manifest ${entry.name}/manifest.json is not valid JSON.`, { entry: entry.name });
      }
      throw error;
    }
    if (manifest?.id !== entry.name) {
      fail("PACK_DIRECTORY_MISMATCH", `Directory ${entry.name} must contain a manifest with id ${entry.name}.`, {
        directory: entry.name,
        packId: manifest?.id,
      });
    }
    manifests.push(manifest);
  }

  return manifests;
}

export async function loadEquipmentCatalog(equipmentDirectory) {
  if (typeof equipmentDirectory !== "string" || equipmentDirectory.length === 0) {
    fail("INVALID_MANIFEST_PATH", "Equipment directory must be a non-empty path.");
  }
  const root = await realpath(resolve(equipmentDirectory));
  if (!(await stat(root)).isDirectory()) {
    fail("INVALID_MANIFEST_PATH", "Equipment directory must be a directory.");
  }

  const packs = await readManifestDirectory(root, "packs");
  const skills = await readManifestDirectory(root, "skills");
  return [...packs, ...skills];
}
