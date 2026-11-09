import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCredentialRefreshLock,
  getAgentPaths,
  loadCodexCredentials,
  saveTetrisCredentials,
} from "../src/credentials.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-credentials-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("never uses Fx credentials; Tetris requires its own login", async () => {
  await withTempDir(async (directory) => {
    const tetrisCredentialsPath = join(directory, "tetris", "credentials.json");
    const fxCredentialsPath = join(directory, "fx", "chatgpt-auth.json");
    const source = JSON.stringify({
      access_token: "fx-access-token",
      refresh_token: "fx-refresh-token",
      account_id: "account-1",
    });
    await mkdir(join(directory, "fx"), { recursive: true });
    await writeFile(fxCredentialsPath, source, "utf8");

    assert.equal(await loadCodexCredentials({ tetrisCredentialsPath }), null);
    assert.equal(await readFile(fxCredentialsPath, "utf8"), source);
  });
});

test("stores refreshed credentials privately without modifying Fx auth", async () => {
  await withTempDir(async (directory) => {
    const tetrisCredentialsPath = join(directory, "tetris", "credentials.json");
    const fxCredentialsPath = join(directory, "fx", "chatgpt-auth.json");
    await mkdir(join(directory, "fx"), { recursive: true });
    const source = JSON.stringify({ access_token: "existing-fx-token" });
    await writeFile(fxCredentialsPath, source, "utf8");

    await saveTetrisCredentials({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
      accountId: "account-2",
      expiresAt: 1_900_000_000_000,
    }, tetrisCredentialsPath);

    const loaded = await loadCodexCredentials({ tetrisCredentialsPath });
    assert.equal(loaded.source, "tetris");
    assert.equal(loaded.credentials.accessToken, "refreshed-access-token");
    assert.equal((await stat(tetrisCredentialsPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(fxCredentialsPath, "utf8"), source);
  });
});

test("rejects a malformed Tetris credential file", async () => {
  await withTempDir(async (directory) => {
    const tetrisCredentialsPath = join(directory, "credentials.json");
    await writeFile(tetrisCredentialsPath, JSON.stringify({ accessToken: "" }), "utf8");
    await assert.rejects(
      loadCodexCredentials({ tetrisCredentialsPath }),
      { code: "INVALID_CREDENTIALS" },
    );
  });
});

test("resolves independent XDG config and data paths", () => {
  const paths = getAgentPaths({
    home: "/home/user",
    env: { XDG_CONFIG_HOME: "/tmp/config", XDG_DATA_HOME: "/tmp/data" },
  });
  assert.equal(paths.configDirectory, "/tmp/config/tetris-agent");
  assert.equal(paths.dataDirectory, "/tmp/data/tetris-agent");
  assert.equal(paths.credentialsFile, "/tmp/config/tetris-agent/credentials.json");
  assert.equal(paths.profileFile, "/tmp/config/tetris-agent/profile.json");
  assert.match(paths.defaultProfileFile, /agent\/profile\.json$/);
  assert.equal(paths.sessionsDirectory, "/tmp/data/tetris-agent/sessions");
});

test("serializes concurrent Codex refreshes", async () => {
  const lock = createCredentialRefreshLock();
  let active = 0;
  let maximumActive = 0;
  await Promise.all([1, 2, 3].map(() => lock({ provider: "codex" }, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    active -= 1;
  })));
  assert.equal(maximumActive, 1);
});
