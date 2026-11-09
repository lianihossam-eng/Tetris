# Tetris

Tetris is the standalone coding-agent fork of [Fx](https://github.com/vercel-labs/fx), maintained at [lianihossam-eng/Tetris](https://github.com/lianihossam-eng/Tetris). It builds on Fx's Zig runtime and ships as the native `tetris` executable.

Tetris has its own installation, release channel, and global profile. The installer places `tetris` in `~/.local/bin` by default and does not replace an installed `fx`. User state defaults to `~/.tetris`; set `TETRIS_HOME` to choose another profile directory.

Some integration contracts retain their Fx names for compatibility: the npm SDK is `libfx`, ACP metadata uses `_meta.fx`, project defaults use `.fx.json`, workspace skills use `.fx/skills`, and some runtime controls retain `FX_*` names. These shared names do not change Tetris's executable, release source, or global profile.

On macOS, Tetris uses separate `TETRIS_*` Keychain services. Existing Fx credentials remain untouched; sign in to Tetris separately.

## Features

- **Terminal-first agent**: conversations stay in terminal scrollback, with shell commands, file operations, web access, and subagents.
- **Permissions**: `auto`, `ask`, and `full-access` modes control tool execution.
- **Sessions**: Tetris saves conversations under `~/.tetris/sessions/`; `tetris -c` resumes the active project session.
- **Extensions**: add skills from `~/.tetris/skills/` or `.fx/skills/`, configure MCP servers, and use project `AGENTS.md` instructions.
- **Automation and embedding**: `tetris ask --json` returns structured output, `tetris acp` serves editors over ACP, and [libfx](sdk/README.md) remains available to JavaScript applications.

## Install

The installer downloads a stable release from the Tetris GitHub repository and verifies its SHA-256 checksum before installing. The first stable install is available after the Tetris release workflow publishes `v0.1.0`.

```bash
curl -fsSL https://raw.githubusercontent.com/lianihossam-eng/Tetris/main/scripts/install.sh | bash
```

The default destination is `~/.local/bin/tetris`. Set `TETRIS_INSTALL_DIR` to choose another directory or `TETRIS_VERSION` to install a specific stable tag. Run `tetris upgrade` to install the latest stable release.

## Quick start

```bash
tetris login
cd your-project
tetris
```

Type a request and press Enter. `/help` lists slash commands. Run `tetris doctor` to inspect local configuration and runtime health.

For a single request:

```bash
tetris ask "Explain the changes in this repository"
tetris ask --json "Summarize the failing tests" | jq -r .final_output
```

## Extend Tetris

| Surface | Use |
| --- | --- |
| `tetris ask` | Send a request from a script or CI job. `--json` returns structured output, and `--resume` continues a saved session. |
| `tetris acp` | Connect an editor or another [Agent Client Protocol](https://agentclientprotocol.com/) client over stdio. |
| [libfx](https://www.npmjs.com/package/libfx) | Embed the shared agent core in a JavaScript application with custom tools, MCP clients, and skills. |

Tetris loads skills from `.fx/skills`, `~/.tetris/skills`, and compatible folders such as `.claude/skills` and `.agents/skills`. It reads project `AGENTS.md` files and global instructions from `~/.tetris/AGENTS.md`. MCP servers can be managed with `tetris mcp`.

### Equipment and profiles

Tetris equipment is the set of executable native tools a profile selects: workspace read, edit, and search, shell commands, web access, user questions, delegation, and MCP. Profiles filter those tools before the model sees them, and sensitive tool calls still go through the native permission system.

The built-in `main` profile is the default and keeps a curated tool list for everyday coding. The built-in `full` profile allows every native tool, including optional vision and skill-management tools; start it with `tetris --profile full`. To choose a different set, create `~/.tetris/agents/<name>/profile.json` with a `description` and a `tools` list, then select it for an interactive session with `tetris --profile <name>`:

```json
{
  "description": "Review-only equipment",
  "tools": ["read_file", "glob_files", "grep_files", "web_fetch"]
}
```

A `tools` list names native tools; `*` adds every native tool and `!name` removes one. The list selects that profile's tools. Profiles also resolve from a repository's `.tetris/agents/`, but a repository profile cannot set the permission mode.

Skills are not equipment. A skill is a Markdown instruction set loaded from the folders above; it guides the model but adds no executable tool or permission.

## Documentation

The [Fx manual](https://fx.sh/docs) describes inherited agent features. It uses Fx's executable and default profile paths; use this README for Tetris-specific installation and paths. The [libfx README](sdk/README.md) documents the shared JavaScript SDK.

## For coding agents

Use `tetris ask` for non-interactive requests. It writes the answer to stdout, progress and diagnostics to stderr, and returns a nonzero status when the request fails. With `--json`, the final answer is in `final_output`.

Use `tetris status --json` for configuration and runtime information, or `tetris doctor --json` for local health checks. Neither changes the setup. `tetris ask` uses the saved permission mode; pass `--full-access` only when the user asks for it.

To change this repository, read [AGENTS.md](AGENTS.md), then build and verify with `./zig-out/bin/tetris`.

## Feedback

Run `/feedback` inside Tetris or [open an issue in the Tetris repository](https://github.com/lianihossam-eng/Tetris/issues/new/choose). Review `/trace` output and remove secrets before attaching it to a public issue.

## Contributing

Install [Zig 0.17.0](https://ziglang.org/download/) to build Tetris:

```bash
git clone https://github.com/lianihossam-eng/Tetris.git
cd Tetris
zig build
./zig-out/bin/tetris
```

Use the freshly built `./zig-out/bin/tetris` to verify changes. `zig build test` runs the Zig unit tests. End-to-end tests in [`tests/e2e/`](tests/e2e) use tmux and [Bun](https://bun.sh).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request to Tetris.

## License

[Apache-2.0](LICENSE). Third-party licenses and attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
