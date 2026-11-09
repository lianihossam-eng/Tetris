# Contrat Tetris et seams d’extension

## Décision de construction

Le paquet Node autonome vit sous `agent/`. Il est construit sur `libfx@0.0.16`, le SDK hérité de Fx, avec Node 24. Il laisse le runtime natif Tetris distinct; le dépôt amont `vercel-labs/fx` n'est pas modifié par ce paquet. Tetris assemble ses propres tools et équipements autour de `createFxAgent()`.

## Contrats natifs Tetris et SDK libfx

`src/builtins/tools.zig` définit 16 tools dans `all`; `advertisement_order` en expose 14 au modèle : `read_file`, `glob_files`, `grep_files`, `edit_file`, `write_file`, `shell`, `subagent`, `capability_search`, `skill`, `install_skill`, `mcp_select_tool`, `ask_user_question`, `web_fetch` et `web_search`. Le binaire natif Tetris garde ces handlers, permissions et contrats.

Le contrat `FxAgentHostTool` dans `sdk/types/libfx.d.cts` demande `idempotent` pour chaque tool; `writes` impose l’exécution séquentielle pour les mutations. `execute(input, context)` reçoit le signal d’annulation et le contexte de session. `createFxAgent()` accepte `instructions`, `tools`, un provider et une durabilité; `libfx/durable-local` fournit les sessions locales. Le provider Codex expose `credentials`, `onCredentials` et `refreshLock`.

## Équipements Tetris

- Le registre vérifie les identifiants, slots/capacités, dépendances, cycles, conflits, doublons et budget avant activation. Les changements de profil sont atomiques.
- `agent/profile.json` est le profil livré; les changements utilisateur vont dans `$XDG_CONFIG_HOME/tetris-agent/profile.json` ou `~/.config/tetris-agent/profile.json`.
- Le profil livré active 9 outils exécutables sur un budget de 12; le pack Craft reste optionnel et ajoute `craft_chat` et `craft_report`.
- Les équipements actifs couvrent les fichiers workspace, la recherche `glob`/`grep`, le shell approuvé, la récupération web, le todo de session et la délégation bornée.
- Aucun `SKILL.md` OMP n'est livré ou actif. L'extension de skills reste facultative; les outils n'injectent pas de corps Markdown dans le prompt.
- Les outils MCP de Craft ne sont pas chargés en bloc; seul le pack optionnel expose `chat` et `report`.

## Credentials et exécution

Node 24 et `libfx@0.0.16` sont les prérequis du package. Le modèle se choisit avec `--model` ou via la configuration de l'utilisateur.

Le flux `tetris-agent login` stocke des credentials propres à Tetris, en mode fichier `0600` et par écriture atomique. Le runtime ne lit, ne rafraîchit ni ne modifie `~/.fx/chatgpt-auth.json`; cela évite de casser la session Fx lors d’une rotation de refresh token. Le doctor vérifie le login sans afficher de secret.

Le smoke Codex a vérifié la lecture d'un fichier temporaire par `read_file`, puis la reprise de la session après redémarrage du runtime. Les tests ne journalisent aucun secret et le flux de login garde les identifiants propres à Tetris.


## Validation et limites

`npm test` couvre les packs, l'activation des profils, les handlers, l'isolation des credentials et le CLI. `npm run verify` relance ces tests et `doctor`; le smoke Codex réseau est sauté si aucun credential Tetris n'existe.
