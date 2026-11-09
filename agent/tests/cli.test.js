import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { main } from "../src/cli.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "tetris-cli-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

test("help describes the minimal commands and approval boundary", async () => {
  const output = capture();
  await main(["--help"], { output: output.stream });
  assert.match(output.text(), /tetris-agent equipment add/);
  assert.match(output.text(), /n'est pas sandboxé/);
});

test("login writes Tetris credentials only and never alters Fx authentication", async () => {
  await withTempDir(async (home) => {
    const xdgConfigHome = join(home, ".config");
    const fxDirectory = join(home, ".fx");
    await mkdir(fxDirectory, { recursive: true });
    const fxCredentialsPath = join(fxDirectory, "chatgpt-auth.json");
    const fxSource = JSON.stringify({ access_token: "existing-fx-token", refresh_token: "existing-fx-refresh" });
    await writeFile(fxCredentialsPath, fxSource, "utf8");
    const output = capture();
    const error = capture();
    let finishedAddress;

    await main(["login"], {
      input: Readable.from(["http://localhost:1455/?code=temporary-code&state=temporary-state\n"]),
      output: output.stream,
      error: error.stream,
      home,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      loginApi: {
        async startSignIn() {
          return { url: "https://auth.example.test/authorize", verifier: "never-print-this" };
        },
        async finishSignIn(signIn, address) {
          assert.equal(signIn.verifier, "never-print-this");
          finishedAddress = address;
          return {
            accessToken: "tetris-access-token",
            refreshToken: "tetris-refresh-token",
            accountId: "tetris-account",
          };
        },
      },
    });

    const tetrisCredentialsPath = join(xdgConfigHome, "tetris-agent", "credentials.json");
    assert.equal(finishedAddress, "http://localhost:1455/?code=temporary-code&state=temporary-state");
    assert.deepEqual(JSON.parse(await readFile(tetrisCredentialsPath, "utf8")), {
      accessToken: "tetris-access-token",
      refreshToken: "tetris-refresh-token",
      accountId: "tetris-account",
    });
    assert.equal((await stat(tetrisCredentialsPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(fxCredentialsPath, "utf8"), fxSource);
    assert.doesNotMatch(output.text(), /tetris-access-token|tetris-refresh-token|never-print-this/);
  });
});

test("ask refuses Fx credentials until Tetris has its own login", async () => {
  await withTempDir(async (home) => {
    const xdgConfigHome = join(home, ".config");
    const fxDirectory = join(home, ".fx");
    await mkdir(fxDirectory, { recursive: true });
    await writeFile(join(fxDirectory, "chatgpt-auth.json"), JSON.stringify({ access_token: "fx-token" }), "utf8");
    const output = capture();
    const error = capture();
    let runtimeStarted = false;

    await assert.rejects(main(["ask", "Read a file"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      home,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      runtimeFactory: async () => {
        runtimeStarted = true;
        throw new Error("runtime should not start");
      },
    }), { code: "CREDENTIALS_REQUIRED" });
    assert.equal(runtimeStarted, false);
  });
});

test("equipment help works before a subcommand", async () => {
  for (const flag of ["--help", "-h"]) {
    const output = capture();
    await main(["equipment", flag], { output: output.stream });
    assert.equal(output.text(), "Équipements: list | add <pack-id> | remove <pack-id>\n");
  }
});

test("commands reject options they do not support", async () => {
  const output = capture();
  const error = capture();
  const io = {
    input: Readable.from([]),
    output: output.stream,
    error: error.stream,
  };

  await assert.rejects(main(["doctor", "--model", "ignored"], io), /doctor ne prend pas en charge: --model/);
  await assert.rejects(main(["equipment", "list", "--session", "ignored"], io), /equipment list ne prend pas en charge: --session/);
});

test("equipment CLI activates and removes optional tools atomically", async () => {
  await withTempDir(async (home) => {
    const profileFile = join(home, "custom-profile.json");
    const output = capture();
    const error = capture();
    const options = {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      home,
      cwd: home,
      env: { XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH },
    };

    await main(["equipment", "add", "craft", "--profile", profileFile], options);
    const activated = JSON.parse(await readFile(profileFile, "utf8"));
    assert.ok(activated.packs.includes("craft"));

    const activeDoctor = capture();
    await main(["doctor", "--json", "--profile", profileFile], { ...options, output: activeDoctor.stream });
    const activeReport = JSON.parse(activeDoctor.text());
    assert.equal(activeReport.activeTools.length, 11);
    assert.equal(new Set(activeReport.activeTools).size, 11);

    await main(["equipment", "remove", "craft", "--profile", profileFile], options);
    const deactivated = JSON.parse(await readFile(profileFile, "utf8"));
    assert.equal(deactivated.packs.includes("craft"), false);

    const defaultDoctor = capture();
    await main(["doctor", "--json", "--profile", profileFile], { ...options, output: defaultDoctor.stream });
    assert.equal(JSON.parse(defaultDoctor.text()).activeTools.length, 9);
  });
});
