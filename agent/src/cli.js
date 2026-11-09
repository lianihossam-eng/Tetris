import { access, constants, readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  CredentialError,
  getAgentPaths,
  loadCodexCredentials,
  saveTetrisCredentials,
} from "./credentials.js";
import { createTetrisRuntime, loadTetrisConfiguration } from "./runtime.js";
import { saveProfileAtomically } from "./equipment/profile.js";
import { loadEquipmentCatalog } from "./equipment/catalog.js";
import { DEFAULT_EQUIPMENT_POLICY } from "./equipment/registry.js";
import { createTerminalShellApproval } from "./tools/shell.js";

const HELP = `Tetris Agent — agent de code léger construit sur Fx

Usage:
  tetris-agent [chat] [--workspace PATH] [--session ID] [--model ID]
  tetris-agent ask <message> [--workspace PATH] [--session ID] [--model ID]
  tetris-agent login
  tetris-agent doctor [--json] [--workspace PATH] [--profile PATH]
  tetris-agent equipment list
  tetris-agent equipment add <pack-id> [--profile PATH]
  tetris-agent equipment remove <pack-id> [--profile PATH]

Le shell demande une approbation explicite et n'est pas sandboxé.
Les skills se chargent uniquement à la demande. Les équipements sont validés avant activation.`;

function parseOptions(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (["--workspace", "--profile", "--session", "--model"].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} demande une valeur.`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Option inconnue: ${argument}`);
    positionals.push(argument);
  }
  return { options, positionals };
}

function assertAllowedOptions(options, allowed, command) {
  const unsupported = Object.keys(options).filter(
    (option) => option !== "help" && !allowed.includes(option),
  );
  if (unsupported.length > 0) {
    throw new Error(`${command} ne prend pas en charge: ${unsupported.map((option) => `--${option}`).join(", ")}.`);
  }
}

function commandEnvironment(env, profileOverride) {
  if (!profileOverride) return env;
  return { ...env, TETRIS_PROFILE: profileOverride };
}

function commandOptions(options, { cwd, env, home }) {
  return {
    workspaceRoot: resolve(options.workspace ?? cwd),
    ...(options.profile ? { profileFile: resolve(options.profile) } : {}),
    env: commandEnvironment(env, options.profile),
    ...(home === undefined ? {} : { home }),
  };
}

async function assertLoggedIn(paths) {
  const stored = await loadCodexCredentials({ tetrisCredentialsPath: paths.credentialsFile });
  if (!stored) {
    throw new CredentialError("CREDENTIALS_REQUIRED", "Connecte Tetris Agent avec `tetris-agent login` avant de démarrer un tour.");
  }
}

async function streamTurn(session, prompt, { output, error, sessionIdWasKnown }) {
  const turn = session.prompt(prompt);
  const accepted = await turn.accepted;
  if (!sessionIdWasKnown) error.write(`Session: ${accepted.sessionId}\n`);
  for await (const event of turn) {
    if (event.type === "text_delta") output.write(event.delta);
    else if (event.type === "tool_start") error.write(`[outil] ${event.name}\n`);
  }
  const result = await turn.result;
  if (result.stopReason === "error") throw new Error("Le tour Fx s'est terminé avec une erreur.");
  if (result.stopReason !== "end_turn") error.write(`\n[fin du tour: ${result.stopReason}]\n`);
  output.write("\n");
  return accepted;
}

async function runAsk(prompt, options, io, runtimeFactory) {
  if (prompt.trim().length === 0) throw new Error("Le message ne peut pas être vide.");
  const runtimeOptions = commandOptions(options, io);
  const paths = getAgentPaths({ env: runtimeOptions.env, ...(io.home === undefined ? {} : { home: io.home }) });
  await assertLoggedIn(paths);
  const runtime = await runtimeFactory({
    ...runtimeOptions,
    model: options.model ?? runtimeOptions.env.TETRIS_MODEL,
    approveShell: createTerminalShellApproval({ input: io.input, output: io.error }),
  });
  try {
    const session = runtime.agent.session(options.session);
    await streamTurn(session, prompt, {
      output: io.output,
      error: io.error,
      sessionIdWasKnown: Boolean(options.session),
    });
  } finally {
    await runtime.close();
  }
}

async function runChat(initialPrompt, options, io, runtimeFactory) {
  const runtimeOptions = commandOptions(options, io);
  const paths = getAgentPaths({ env: runtimeOptions.env, ...(io.home === undefined ? {} : { home: io.home }) });
  await assertLoggedIn(paths);
  const promptInterface = createInterface({ input: io.input, output: io.output });
  let runtime;
  try {
    const approveShell = async (command, { workspaceRoot, timeoutMs }) => {
      if (!io.input.isTTY || !io.output.isTTY) return false;
      const answer = await promptInterface.question(
        `Autoriser cette commande shell dans ${workspaceRoot} (non sandboxée, délai ${timeoutMs} ms)?\n${JSON.stringify(command)}\nTapez oui (ou yes) pour exécuter: `,
      );
      const confirmation = answer.trim().toLowerCase();
      return confirmation === "oui" || confirmation === "yes";
    };
    runtime = await runtimeFactory({
      ...runtimeOptions,
      model: options.model ?? runtimeOptions.env.TETRIS_MODEL,
      approveShell,
    });
    const session = runtime.agent.session(options.session);
    let sessionIdWasKnown = Boolean(options.session);
    if (initialPrompt.trim().length > 0) {
      const accepted = await streamTurn(session, initialPrompt, {
        output: io.output,
        error: io.error,
        sessionIdWasKnown,
      });
      sessionIdWasKnown = Boolean(accepted.sessionId);
    }
    while (true) {
      let line;
      try {
        line = await promptInterface.question("tetris-agent> ");
      } catch {
        break;
      }
      const prompt = line.trim();
      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt.length === 0) continue;
      const accepted = await streamTurn(session, prompt, {
        output: io.output,
        error: io.error,
        sessionIdWasKnown,
      });
      sessionIdWasKnown = Boolean(accepted.sessionId);
    }
  } finally {
    promptInterface.close();
    if (runtime) await runtime.close();
  }
}

async function runLogin(io, loginApi) {
  const auth = loginApi ?? await import("libfx/chatgpt");
  const { startSignIn, finishSignIn } = auth;
  const paths = getAgentPaths({ env: io.env, ...(io.home === undefined ? {} : { home: io.home }) });
  const promptInterface = createInterface({ input: io.input, output: io.output });
  try {
    const signIn = await startSignIn();
    io.output.write(`Ouvrez cette adresse pour connecter le compte Tetris:\n${signIn.url}\n\n`);
    const address = await promptInterface.question("Collez ici l'adresse localhost:1455 affichée après la connexion: ");
    const credentials = await finishSignIn(signIn, address.trim());
    await saveTetrisCredentials(credentials, paths.credentialsFile);
    io.output.write("Connexion Tetris enregistrée dans son propre dossier de configuration.\n");
  } finally {
    promptInterface.close();
  }
}

async function findExecutable(command, env) {
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return null;
}

async function libfxVersion() {
  const entry = fileURLToPath(import.meta.resolve("libfx"));
  const packageFile = join(dirname(entry), "package.json");
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  return manifest.version;
}

async function runDoctor(options, io) {
  const runtimeOptions = commandOptions(options, io);
  const configuration = await loadTetrisConfiguration(runtimeOptions);
  const paths = configuration.paths;
  const stored = await loadCodexCredentials({ tetrisCredentialsPath: paths.credentialsFile });
  const version = await libfxVersion();
  const checks = [
    { name: "Node.js", status: Number(process.versions.node.split(".")[0]) >= 24 ? "OK" : "VERSION INCOMPATIBLE", detail: process.version },
    { name: "libfx", status: version === "0.0.16" ? "OK" : "VERSION DIFFÉRENTE", detail: version },
    { name: "Équipements", status: "OK", detail: `${configuration.activeEquipment.toolCount}/${DEFAULT_EQUIPMENT_POLICY.maxTools} outils; ${configuration.activeEquipment.packs.length} packs actifs.` },
    { name: "Codex", status: stored ? "OK" : "CONNEXION REQUISE", detail: stored ? "Identifiants Tetris présents; aucune valeur secrète affichée." : "Exécutez `tetris-agent login`. Les identifiants Fx ne sont jamais réutilisés." },
  ];
  const craftPackActive = configuration.activeEquipment.packs.some((pack) => pack.id === "craft");
  if (craftPackActive) {
    const executable = await findExecutable(io.env.CRAFT_ANYTHING_CLI || "craft-anything-cli", io.env);
    checks.push({
      name: "Craft Anything",
      status: executable ? "OK" : "EXÉCUTABLE INTROUVABLE",
      detail: executable ?? "Désactivez le pack craft ou installez craft-anything-cli.",
    });
  }
  if (options.json) {
    io.output.write(`${JSON.stringify({ checks, activeTools: configuration.activeEquipment.tools }, null, 2)}\n`);
  } else {
    for (const check of checks) io.output.write(`${check.status.padEnd(22)} ${check.name}: ${check.detail}\n`);
    io.output.write(`Workspace: ${configuration.workspaceRoot}\n`);
    io.output.write(`Modèle: ${io.env.TETRIS_MODEL || "gpt-6.1-terra"}\n`);
  }
}

async function runEquipment(subcommand, args, io) {
  const { options, positionals } = parseOptions(args);
  if (options.help || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.output.write("Équipements: list | add <pack-id> | remove <pack-id>\n");
    return;
  }
  assertAllowedOptions(options, ["profile"], `equipment ${subcommand}`);
  const runtimeOptions = commandOptions(options, io);
  const configuration = await loadTetrisConfiguration(runtimeOptions);
  if (subcommand === "list") {
    if (positionals.length !== 0) throw new Error("equipment list n'accepte pas d'argument supplémentaire.");
    const active = new Set(configuration.activeEquipment.profile.packs);
    const catalog = await loadEquipmentCatalog(configuration.equipmentDirectory);
    for (const pack of catalog) {
      const description = pack.description || pack.name || "";
      const dependencies = pack.requires.length > 0 ? `; dépend de ${pack.requires.join(", ")}` : "";
      io.output.write(`${active.has(pack.id) ? "[actif]" : "[off]  "} ${pack.id} — slot ${pack.slot}; outils: ${pack.tools.join(", ") || "aucun"}${dependencies}${description ? `\n        ${description}` : ""}\n`);
    }
    return;
  }
  const [packId, ...extra] = positionals;
  if ((subcommand !== "add" && subcommand !== "remove") || !packId || extra.length > 0) {
    throw new Error("Usage: tetris-agent equipment list | add <pack-id> | remove <pack-id>");
  }
  const change = subcommand === "add"
    ? configuration.registry.activate(configuration.profile, packId)
    : configuration.registry.deactivate(configuration.profile, packId);
  await saveProfileAtomically(configuration.profileFile, change.profile, { registry: configuration.registry });
  const changed = subcommand === "add" ? change.added : change.removed;
  io.output.write(changed.length > 0
    ? `${subcommand === "add" ? "Ajouté" : "Retiré"}: ${changed.join(", ")}\nOutils actifs: ${configuration.registry.validate(change.profile).toolCount}/${DEFAULT_EQUIPMENT_POLICY.maxTools}\n`
    : `${packId} était déjà dans cet état.\n`);
}

export async function main(argv = process.argv.slice(2), {
  input = stdin,
  output = stdout,
  error = stderr,
  env = process.env,
  cwd = process.cwd(),
  home,
  runtimeFactory = createTetrisRuntime,
  loginApi,
} = {}) {
  const io = { input, output, error, env, cwd, home };
  const [command = "chat", ...args] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    output.write(`${HELP}\n`);
    return;
  }
  if (command === "login") {
    const { options, positionals } = parseOptions(args);
    if (options.help) {
      output.write("Usage: tetris-agent login\n");
      return;
    }
    assertAllowedOptions(options, [], "login");
    if (positionals.length > 0) throw new Error("login n'accepte pas d'argument positionnel.");
    await runLogin(io, loginApi);
    return;
  }
  if (command === "doctor") {
    const { options, positionals } = parseOptions(args);
    if (options.help) {
      output.write("Usage: tetris-agent doctor [--json] [--workspace PATH] [--profile PATH]\n");
      return;
    }
    assertAllowedOptions(options, ["json", "workspace", "profile"], "doctor");
    if (positionals.length > 0) throw new Error("doctor n'accepte pas d'argument positionnel.");
    await runDoctor(options, io);
    return;
  }
  if (command === "equipment") {
    const [subcommand = "list", ...rest] = args;
    await runEquipment(subcommand, rest, io);
    return;
  }
  if (command === "ask" || command === "chat") {
    const { options, positionals } = parseOptions(args);
    if (options.help) {
      output.write(command === "ask" ? "Usage: tetris-agent ask <message> [--workspace PATH] [--session ID] [--model ID]\n" : HELP);
      return;
    }
    assertAllowedOptions(options, ["workspace", "profile", "session", "model"], command);
    const prompt = positionals.join(" ");
    if (command === "ask") {
      if (positionals.length === 0) throw new Error("Usage: tetris-agent ask <message>");
      await runAsk(prompt, options, io, runtimeFactory);
    } else {
      await runChat(prompt, options, io, runtimeFactory);
    }
    return;
  }
  throw new Error(`Commande inconnue: ${command}. Utilisez [1mtetris --help[0m.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    stderr.write(`Tetris: ${error.message ?? "commande échouée"}\n`);
    process.exitCode = 1;
  });
}
