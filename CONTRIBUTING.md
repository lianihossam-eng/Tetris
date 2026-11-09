# Contributing to Tetris

Tetris is the `lianihossam-eng/Tetris` fork of [Fx](https://github.com/vercel-labs/fx). This repository is the source of truth for the Tetris product, its releases, and its GitHub Actions. Send pull requests to this repository's `main` branch. Do not push changes to upstream Fx.

Code conventions live in [AGENTS.md](AGENTS.md): module ownership, Zig 0.17, permissions, tests, and coding-agent rules. Read it before changing code.

## Report a problem

Run `/feedback` inside Tetris or [open an issue](https://github.com/lianihossam-eng/Tetris/issues/new/choose). Describe what you did, what you expected, and what happened instead. Review `/trace` output and remove secrets before attaching it to a public issue.

Report security vulnerabilities privately through the repository's [Security page](https://github.com/lianihossam-eng/Tetris/security), not in a public issue.

## Set up a checkout

You need:

- [Zig 0.17.0](https://ziglang.org/download/), the version CI builds with. Check `zig version` before building.
- [Bun](https://bun.sh) and [tmux](https://github.com/tmux/tmux) for end-to-end tests.
- [hyperfine](https://github.com/sharkdp/hyperfine) for local startup benchmarks.

Most unit and end-to-end tests do not call a model. Model-backed tests need an account configured as described in the [README](README.md#quick-start) or `AI_GATEWAY_API_KEY`.

Clone the Tetris repository and build its native executable:

```bash
git clone https://github.com/lianihossam-eng/Tetris.git
cd Tetris
zig build
./zig-out/bin/tetris
```

Use `./zig-out/bin/tetris` to test changes. A bare `tetris` may run an installed release instead of this checkout.

Tetris stores profile settings and sessions in `~/.tetris` by default. Set `TETRIS_HOME` to use another absolute profile directory. To test with an empty profile without changing your own:

```bash
TETRIS_HOME="$(mktemp -d)" FX_DISABLE_KEYCHAIN=1 ./zig-out/bin/tetris
```

## Make a change

Start each change from the latest `main`, and keep each pull request to one change. Put unrelated formatting, renames, and cleanup in their own pull requests, so each one can be reviewed and reverted on its own.

Before you build a feature, answer the questions in the [Adding a Feature](AGENTS.md#adding-a-feature) section of AGENTS.md. They ask which module owns the behavior, what its typed contract is, whether it needs persistence or JSON output, which docs and tests land with it, and how its end-to-end tests are classified for PGSO. If you can't answer them yet, settle the design before you write code. Outside contributors can propose a design in an issue first.

These rules apply to every change:

- `src/main.zig` only wires runtimes together. Feature logic and state belong to the module that owns them.
- Sensitive tool behavior goes through the permission system in `src/core/permissions/permissions.zig`. Don't add a path around it.
- The native Zig runtime uses only the standard library. Keep npm dependencies for the separate `agent/` package there unless the native runtime needs them.
- Don't commit generated state from `.tetris/`, `.zig-cache/`, or `zig-out/`.
- Don't commit home-directory paths, real team IDs, or personal project slugs. `scripts/check-public-surface.sh` rejects them in CI, so use `/Users/example/` in fixtures.
- Don't document behavior that doesn't exist yet.

If a coding agent helps with your change, point it at AGENTS.md. Any prose the agent writes for your contribution, including pull request titles and descriptions, commit messages, documentation, and issues, must follow the `technical-writer` skill in `.fx/skills/technical-writer/`.

### Add or change a command, flag, or setting

Commands, flags, settings, environment variables, slash commands, and `--json` output are contracts that people and scripts rely on. Keep each control's name and precedence consistent across surfaces:

- A concept has one name in each surface's case, such as `permission_mode`, `--permission-mode`, and the inherited `FX_PERMISSION_MODE` environment variable.
- Tetris-specific profile location uses `TETRIS_HOME`. Existing Fx runtime controls keep their `FX_*` names for compatibility.
- A subcommand is an action, a flag changes one run and never saves, a setting persists, and an environment variable carries context from CI, a wrapper script, or a test.
- Results go to stdout and diagnostics to stderr, `--json` fields are only added, and a usage error exits with 2.
- A rename keeps the old spelling working with a warning that names its replacement and the release that drops it.

The `fx-cli-shape` skill in `.fx/skills/fx-cli-shape/` has the naming rules and control registry. Read it before adding or changing a control. CI's `python3 -m scripts.check_cli_shape` checks `FX_*` and `TETRIS_*` variables, hand-parsed flags, and registered settings. New stable controls need review in the pull request.

## Test your change

Run the tests that cover your change, build Tetris, and exercise the changed path with `./zig-out/bin/tetris`. Tests do not always start the full runtime, attach a TTY, or spawn background threads. Confirm that Tetris did not abort, stderr is clean, and the behavior matches the pull request description.

```bash
zig fmt src/
zig build
zig build test
cd tests/e2e
bun install
bun test cli.test.ts
```

Zig unit tests sit in `test` blocks inside the source file they cover, and `zig build test` runs them. CI checks formatting with `zig fmt --check src/`. End-to-end tests use `zig-out/bin/tetris`, so build before running them. Run only the end-to-end files that cover your change. The `tui-*` files exercise Tetris inside tmux.

### Add an end-to-end test file

Every root `tests/e2e/*.test.ts` file needs an entry in the first three files below, and in the fourth only when it branches on the platform. CI fails when a required entry is missing or stale:

| File | Entry |
| --- | --- |
| `scripts/pgso/corpus.json` | Exactly one classification: training, verification-only, or intentional exclusion |
| `scripts/pgso/tests/test_corpus.py` | The same file in the matching training, verification, or exclusion list, in `corpus.json` order |
| `tests/e2e/ci-shard-weights.json` | A weight that balances the four CI shards |
| `tests/e2e/macos-platform-tests.json` | Needed only when the file branches on `process.platform` or `platform()` being `darwin` or `linux` |

The corpus drives the macOS arm64 PGSO build, which profiles Tetris on the training files, optimizes the code they exercise for speed, and compiles functions they show to be cold for size. Classify common or performance-sensitive behavior as training. Use verification-only for correctness, recovery, security, or rare behavior. Exclude only coverage that is nondeterministic, needs the network or credentials, involves sound, or tests the harness itself, and record the reason.

### Reproduce a rendering bug

Tetris prints into your terminal's scrollback instead of taking over the screen, so many rendering bugs appear only at certain sizes or after a resize. Reproduce a bug at the lowest layer that catches it:

1. A Zig unit test in `src/ui/resize_tests.zig` drives the transcript renderer against an in-process virtual terminal, with no TTY or signals. These tests are the fastest and run in `zig build test`.
2. A tmux test in `tests/e2e/tui-resize.test.ts` covers bugs that need a real terminal and a real `SIGWINCH`. `tests/e2e/tmux-helpers.ts` provides `resizeWindow`, `capturePaneGrid`, and `capturePaneEscapes`.
3. A recorded tape captures a session someone has already seen go wrong. Run Tetris with `FX_RECORD=/tmp/bug.fxtape`, or with `FX_DEBUG_RECORD=1` to write a private tape under `~/.tetris/recordings/`, then replay it without a terminal:

   ```bash
   ./zig-out/bin/tetris replay /tmp/bug.fxtape
   ./zig-out/bin/tetris replay /tmp/bug.fxtape --golden /tmp/bug.txt
   ```

   `--golden` writes the final screen to a file that you can check in as the expected result.

When a tmux test or a tape exposes a bug, reproduce it as a Zig unit test before you fix it, so the fix lands with its regression test.

### Fuzz a parser

A fuzz test is a `test` block that calls `std.testing.fuzz`. `tests/fuzz/targets.json` lists each one as a target, with its exact test name and the module that holds it. `zig build test` runs every fuzz test once on its inline seeds and on each file in `tests/fuzz/corpus/<target>/`. `zig build fuzz` builds only the fuzz tests, and with `--fuzz` Zig searches for new inputs that fail:

```bash
zig build fuzz -Dfuzz-target=sse_framing               # replay the saved inputs
zig build fuzz -Dfuzz-target=sse_framing --fuzz=200K   # try 200,000 new inputs
```

When the search finds a failure, Zig 0.17 prints `error: test '...'` but still exits with status 0, so read the output. Without a limit, `--fuzz` runs until you stop it and opens Zig's web interface.

The Fuzz workflow fuzzes each target on `main` every night for about 20 minutes, and for two minutes on a pull request that changes the fuzzing setup. When the nightly run finds a failure, it uploads the failing input as an artifact and opens an issue titled `Nightly fuzz failure: <target>`, or comments on that issue if it is already open. To fix the failure, copy the input into `tests/fuzz/corpus/<target>/` and run `zig build fuzz -Dfuzz-target=<target>` to reproduce it. That build uses Debug by default, which adds allocation stack traces to leak reports. Keep the input file in the fix's pull request, so `zig build test` replays it on every pull request after that.

A saved input holds the values the test reads from its `std.testing.Smith`, in order. For example, a test that calls `smith.slice` reads a 4-byte little-endian length and then that many bytes. Inputs that the fuzzer saves are already in this form. Inline seeds go through `@import("fuzz_seed").slices`, which writes each one in this form for a test whose first read is `smith.slice`. A seed written as a plain string would lose its first four bytes to the length.

To add a target, write the fuzz test in the file it covers and add an entry to `tests/fuzz/targets.json`. For a target outside the session manager, also import its file in `src/fuzz_targets.zig`. Pass the seeds and saved inputs to the test with `.corpus = &(@import("fuzz_seed").slices(.{ <seeds> }) ++ @import("fuzz_corpus").<target>.*)`. Because the session-manager code has no dependency on the main Tetris module, its targets keep their seeds as files in `tests/fuzz/corpus/<target>/` and pass `.corpus = &(.{""} ++ @import("build_options").fuzz_corpus_<target>.*)`. Set `iterations` so that one round of `--fuzz` takes about 30 seconds on a developer machine. `scripts/tests/test_fuzz_nightly.py` fails when an entry names a test that doesn't exist or that `zig build fuzz` can't reach. The MCP engine in `src/mcp/` imports only the standard library, so its targets live in `src/core/mcp_host/wire_tests.zig`. A file that holds only tests, like that one, is also imported from the test block in `src/main.zig`.

### Find data races

`-Dsanitize-thread=true` builds Tetris and its tests with ThreadSanitizer, which reports unsynchronized access to shared memory. The build is slow and large, so install it to its own prefix:

```bash
TSAN_OPTIONS=halt_on_error=0:abort_on_error=0 zig build test -Dsanitize-thread=true -p /tmp/tetris-tsan
```

Without those options, the sanitizer aborts a test binary once it has reported a race, so that binary's later tests don't run. The Thread Sanitizer workflow runs the unit tests this way on `main` every night and lists each race in its job summary. It reports races without failing. A sanitized suite runs slower, so a few tests that depend on timing fail in it, such as the `command_runner` tests of output read after a command exits. Those failures aren't races.

### Check startup performance

The `Startup Latency` check fails a pull request when any benchmarked command takes longer than 2 ms on the Linux CI runner. To measure before you push, run:

```bash
./benchmarks/startup.sh --quick
```

The script builds a ReleaseSafe binary and needs hyperfine. On macOS, process and dynamic-loader overhead alone can exceed 2 ms, so compare local numbers between builds instead of against the budget. `benchmarks/first_frame.py` measures an interactive launch and can compare a Tetris binary with a baseline.

```bash
python3 benchmarks/first_frame.py --binary /tmp/tetris-before --binary ./zig-out/bin/tetris
```

### Check a TLA+ model

`tests/tla/` holds TLA+ models of Tetris's runtime and its `libfx` integration, such as the session manager, the MCP engine and host, ACP, `/usage`, the shell tool, and the workspace indexer. Most come with Bun drivers that run the real binary and have TLC check what it did. CI runs the libfx and MCP models on `main` and on pull requests that change the code they cover; run the matching checker yourself when you change behavior that one of the others describes. You need Java and `tla2tools.jar`, and `tests/tla/README.md` lists every model and covers setup.

```bash
tests/tla/session_manager/check.sh SessionLog
tests/tla/mcp/check.sh --model Engine
bun test ./tests/tla/drivers/shell_command/
```

### Run the model evals

The evals in `tests/evals/` drive Tetris through `tetris ask --json` against real models and need `AI_GATEWAY_API_KEY`. They make billed model calls and their results vary between runs, so they aren't part of the pull request checks.

```bash
cd tests/evals
bun install
bun test
```

`prompt-cache-ab.test.ts` compares two Tetris builds through mid-session changes: a branch switch, a permission change, folder rules, a restart, and a named skill. It runs only when the variables name two builds and the models to try.

```bash
cd tests/evals
FX_CACHE_AB_BASELINE_BIN=/abs/path/to/base/tetris FX_CACHE_AB_CANDIDATE_BIN=/abs/path/to/zig-out/bin/tetris \
  FX_CACHE_AB_MODELS=anthropic/claude-haiku-5.5,openai/gpt-6.1-sol bun test prompt-cache-ab.test.ts
```

`FX_CACHE_AB_SCENARIOS` picks scenarios by name, and `FX_CACHE_AB_OUTPUT_DIR` keeps each run's requests and summary. One run per scenario varies, so compare several.

## Open a pull request

1. Follow the signature requirements shown for the Tetris repository. Do not assume upstream Fx branch rules apply.
2. Push your feature branch to `lianihossam-eng/Tetris` and open a pull request with base `main`. Never push this work to `vercel-labs/fx`.
3. Open the pull request as a draft after focused checks pass, so GitHub Actions can run.
4. Write the title as a plain imperative sentence, such as `Restore feedback report file clipboard`. Keep type labels out of the title.
5. Describe the user-visible change, why it is needed, and how you verified it, including the command run with `./zig-out/bin/tetris`.

Use relevant labels from the Tetris repository's current label list. Do not assume the upstream `type:` labels or permissions apply.

## CI checks

GitHub Actions runs on pushes to Tetris pull requests, including drafts. Linux x86_64 covers shared behavior. Review the checks on the latest PR commit; CI results from earlier commits do not verify a newer change.

The PR verification baseline is:

| Check | What it runs |
| --- | --- |
| `Build & Test` | Formatting, PGSO corpus, public-surface and module-boundary checks, unit tests, and SDK package jobs |
| `E2E (deterministic)` | End-to-end files split across weighted shards plus the MCP conformance baseline |
| `Shellcheck` | `bash -n` and `shellcheck` on workflow scripts |
| `Startup Latency` | ReleaseSafe CLI startup benchmarks and the interactive performance test |
| `macOS arm64` | macOS checks when the change needs them, otherwise a pass without starting a macOS runner |

The Tetris `main` branch does not currently have branch protection configured. Review the PR checks manually before merging.

CI retries a failed end-to-end file once. A file that passes only on the retry gets a warning annotation, and you should investigate it as a possible race.

`scripts/detect-macos-need.sh` decides whether a change needs macOS. It runs the macOS checks when the change touches:

- A Zig file with a macOS, BSD, or Linux code path
- `build.zig`
- The macOS signing script
- The native SDK addon
- An end-to-end file listed in `tests/e2e/macos-platform-tests.json`
- A shared end-to-end helper that reads the platform

When the detector can't read the change, the `macOS arm64` check fails instead of passing.

`scripts/detect-ci-need.sh` decides whether a pull request runs CI's three model checks. The libfx durable-session model check takes about 40 minutes and runs when the change touches:

- `sdk/`
- The SDK models in `tests/tla/sdk/` or their drivers in `tests/tla/drivers/*.mjs`
- The Node-API or WebAssembly core entry point
- `src/acp/`, `src/core/hosts/`, or `src/core/session_manager/`

The `TLA+ MCP models and drivers` job takes about 20 minutes and runs its checks when the change touches:

- `src/mcp/`, `src/core/mcp_host/`, or `src/core/mcp/`
- The models in `tests/tla/mcp/` or `tests/tla/mcp_host/`, or their drivers in `tests/tla/drivers/mcp/`, `tests/tla/drivers/mcp_host/`, or `tests/tla/drivers/lib/`
- The `tests/e2e/fixtures/mcp-*` servers, or the helpers those drivers load: `tests/e2e/tmux-helpers.ts`, `tests/evals/eval-helpers.ts`, and `tests/e2e/render-lab/tape.ts`

The `TLA+ transcript window model` job takes about 4 minutes and runs its checks when the change touches:

- `src/ui/transcript/transcript_window*`
- The model in `tests/tla/transcript_window/` or its drivers in `tests/tla/drivers/transcript_window/`
- The driver code those drivers share: `tests/tla/drivers/lib/` and `tests/tla/drivers/graph.mjs`

All three run when the change touches `build.zig`, `build.zig.zon`, or `.github/workflows/ci.yml`, and on every push to `main`. When the detector can't read the change, `Build & Test` fails instead of passing.

Other workflows and benchmark jobs also report on pull requests, such as the `Examples` workflow when `examples/` changes and the `Shell command overhead` benchmark. Only the five checks above are required to merge, but look into any check that fails. Two of the others need more explanation:

- The binary size workflow builds each release target for the pull request and its base commit on native runners, reports the size change, and smoke-tests every target's binary. Growth of 52,429 bytes (0.05 MiB) or more on a platform adds a warning. Investigate growth you can't explain.
- The macOS arm64 PGSO workflow runs on a pull request only when the PGSO pipeline itself changes: `scripts/pgso/` other than `corpus.json`, the `setup-pgso` action, or `.github/workflows/pgso-macos-arm64.yml`. Stable releases always run it. [scripts/pgso/README.md](scripts/pgso/README.md) explains the pipeline and its acceptance gates.
- The Linux arm64 PGSO workflow runs on the same pull request paths, with `.github/workflows/pgso-linux-arm64.yml` in place of the macOS workflow file. It qualifies a Linux candidate in one job, which takes several hours. The stable release always runs it and ships its candidate as the Linux arm64 binary. `.github/workflows/pgso-linux-x86_64.yml` qualifies a Linux x86_64 candidate the same way, and the stable release ships it as the Linux x86_64 binary.

Other runs start only on request:

| Run | Command |
| --- | --- |
| macOS checks | `gh workflow run macos.yml --ref your-branch`, or add the `ci:macos` label |
| libfx durable-session and MCP model checks | `gh workflow run ci.yml --ref your-branch` |
| PGSO qualification | `gh workflow run pgso-macos-arm64.yml --ref your-branch` |
| Linux PGSO qualification | `gh workflow run pgso-linux-arm64.yml --ref your-branch` or `pgso-linux-x86_64.yml` |
| Live ACP suite | `gh workflow run ci.yml --ref your-branch -f acp_live=true` |
| Long-turn memory benchmark | `gh workflow run bench.yml --ref your-branch -f long_turn_memory=true` |
| libfx runtime benchmark | `gh workflow run bench.yml --ref your-branch -f libfx_runtime=true` |
| Fuzzing of one target | `gh workflow run fuzz.yml --ref your-branch -f target=<target>` |
| Unit tests with ThreadSanitizer | `gh workflow run tsan.yml --ref your-branch` |

Use `workflow_dispatch` in the Tetris repository for optional runs when you have write access. Runs that require GitHub secrets need those secrets configured in Tetris. A first-time workflow run may need approval in GitHub.

## Mark it ready for review

Mark the pull request ready when all of these hold for its current commit:

1. The PR verification checks passed for the current commit. A queued, cancelled, skipped, or failed run does not count.
2. You ran `./zig-out/bin/tetris` through the changed behavior.
3. The diff against `main` contains only the files this change needs.
4. The documentation that describes the behavior is up to date.

If CI fails, push the smallest fix to the same pull request and wait for a passing run on the new commit.

## Update the docs

Update the documentation in the same pull request as the behavior it describes:

- The `--help` output comes from the command specs in `src/builtins/commands.zig`.
- `sdk/README.md` documents libfx. Update it when libfx's public behavior or setup changes, as [sdk/AGENTS.md](sdk/AGENTS.md) describes.
- Update this file when build steps, development setup, or collaboration rules change.

Keep `README.md` focused on Tetris's installation, identity, and high-level behavior. Put detailed options in `--help`; use the Fx manual only as a reference for inherited features.

For routine behavior changes, do not update the release version or changelog. Release-preparation PRs must update both versions and the changelog as described in [Releases](#releases).

### Changes to the manual

The [Fx manual](https://fx.sh/docs) documents inherited agent features. It is maintained upstream and describes Fx's executable and profile defaults. Keep Tetris-specific installation, profile, and release instructions in this repository.

When a change affects behavior documented only in the Fx manual, describe the affected page and required update in a `## Docs` section of the pull request. Do not claim that a Tetris-specific manual exists.

## Releases

The release workflow reads `pub const version` from `src/main.zig` and the package version from `build.zig.zon`. Keep both versions aligned. When a new tag is missing, the workflow builds the platform binaries, creates the tag, and publishes a GitHub Release in `lianihossam-eng/Tetris`. The release body comes from the current changelog markers. Never create a version tag by hand.

To check release artifacts without publishing, run **Actions > Release** on `main` with `validate_only` enabled. It builds release targets and runs the applicable signing checks. It creates no tag or GitHub Release.

Before the first stable macOS release, configure these **repository-level Actions variables** with Tetris's Apple Developer identity: `APPLE_DEVELOPER_IDENTITY`, `APPLE_TEAM_ID`, and `TETRIS_SIGNING_IDENTIFIER`. The `bench.yml` signed-binary validation also reads the team and signing-identifier variables.

The `apple-signing` environment must contain the existing secrets `APPLE_DEVELOPER_ID_P12_BASE64`, `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_NOTARY_KEY_P8_BASE64`, `APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_ISSUER_ID`. Without the Tetris-owned identity, team, identifier, certificate, and notarization credentials, stable macOS signing cannot run.

After CI passes on `main`, the dev release workflow publishes Tetris binaries for that commit. Run `tetris upgrade --channel dev` to follow those builds, and `tetris upgrade --channel stable` to return to tagged releases.

## License

Tetris is licensed under [Apache-2.0](LICENSE). Unless you state otherwise, a contribution submitted for inclusion in Tetris is licensed under the same terms, as section 5 of the license describes.
