import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { getAgentPaths, loadCodexCredentials } from "../src/credentials.js";
import { createTetrisRuntime } from "../src/runtime.js";

async function runSmoke() {
  const paths = getAgentPaths();
  const credentialsFile = resolve(process.env.TETRIS_CREDENTIALS_FILE || paths.credentialsFile);
  if (!(await loadCodexCredentials({ tetrisCredentialsPath: credentialsFile }))) {
    throw new Error("Tetris Agent Codex login is required; run `tetris-agent login` first.");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "tetris-codex-smoke-"));
  const workspaceRoot = join(temporaryRoot, "workspace");
  const stateDirectory = join(temporaryRoot, "state");
  const sessionsDirectory = join(stateDirectory, "sessions");
  const profileFile = join(temporaryRoot, "profile.json");
  const fixturePath = join(workspaceRoot, "tetris-smoke.txt");
  const token = `TETRIS_${randomUUID().replaceAll("-", "").toUpperCase()}`;

  let firstRuntime;
  let resumedRuntime;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(profileFile, JSON.stringify({ version: 1, packs: ["workspace-files"] }), "utf8");
    await writeFile(fixturePath, token, "utf8");

    const runtimeOptions = {
      workspaceRoot,
      profileFile,
      stateDirectory,
      sessionsDirectory,
      credentialsFile,
      model: process.env.TETRIS_MODEL || "gpt-6.1-terra",
    };
    firstRuntime = await createTetrisRuntime(runtimeOptions);
    const firstSession = firstRuntime.agent.session();
    const firstTurn = firstSession.prompt("Read tetris-smoke.txt and reply with exactly its contents, without quotes.");
    const firstAccepted = await firstTurn.accepted;
    const firstText = [];
    const firstTools = [];
    for await (const event of firstTurn) {
      if (event.type === "text_delta") firstText.push(event.delta);
      if (event.type === "tool_start") firstTools.push(event.name);
    }
    const firstResult = await firstTurn.result;
    if (firstResult.stopReason !== "end_turn"
      || !firstTools.includes("read_file")
      || !firstText.join("").includes(token)) {
      throw new Error("Codex did not read the workspace fixture and return its value.");
    }
    await firstRuntime.close();
    firstRuntime = undefined;
    await unlink(fixturePath);

    resumedRuntime = await createTetrisRuntime(runtimeOptions);
    const resumedSession = resumedRuntime.agent.session(firstAccepted.sessionId);
    const resumedTurn = resumedSession.prompt("What exact token did you read from the workspace file? Reply with the token only.");
    const resumedText = [];
    for await (const event of resumedTurn) {
      if (event.type === "text_delta") resumedText.push(event.delta);
    }
    const resumedResult = await resumedTurn.result;
    if (resumedResult.stopReason !== "end_turn" || !resumedText.join("").includes(token)) {
      throw new Error("The Codex session did not retain its workspace result after restart.");
    }
  } finally {
    if (firstRuntime) await firstRuntime.close();
    if (resumedRuntime) await resumedRuntime.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await runSmoke();
  console.log("Tetris smoke passed: Codex read a workspace file and resumed the persisted session.");
} catch (error) {
  console.error(`Tetris smoke failed${error?.code ? ` (${error.code})` : ""}; run [1mtetris doctor[0m for setup details.`);
  process.exitCode = 1;
}
