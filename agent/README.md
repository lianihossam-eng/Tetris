# Tetris Agent

Agent de code léger construit sur le SDK `libfx`, hérité de Fx. Le paquet autonome vit dans `agent/`; il expose ses propres équipements déclaratifs sans altérer le runtime natif Tetris. Le dépôt amont `vercel-labs/fx` reste indépendant. Le binaire npm est `tetris-agent`, distinct du CLI natif `tetris`.

## Démarrer

Prérequis : Node.js 24 ou plus récent.

```sh
cd agent
npm ci
npm link
tetris-agent doctor
tetris-agent login
tetris-agent chat
```

`tetris-agent login` ouvre le flux OAuth Codex de `libfx`. Ouvrez l'URL affichée, puis collez l'adresse `localhost:1455` retournée par OpenAI. Tetris conserve ses identifiants dans `$XDG_CONFIG_HOME/tetris-agent/credentials.json` (ou `~/.config/tetris-agent/credentials.json`), avec les permissions du fichier limitées à l'utilisateur. Tetris ne lit, ne rafraîchit et ne modifie jamais `~/.fx/chatgpt-auth.json`; cette séparation protège la connexion Fx.

Autres commandes :

```sh
tetris-agent ask "Lis le fichier README et résume-le"
tetris-agent ask "Continue cette tâche" --session <id>
tetris-agent chat --session <id>
tetris-agent equipment list
tetris-agent equipment add craft
tetris-agent equipment remove craft
tetris-agent doctor --json
```

`ask` imprime l'identifiant de session pour reprendre la conversation. `chat` accepte `/exit` et `/quit`. Les sessions locales sont conservées sous `$XDG_DATA_HOME/tetris-agent/sessions` (ou `~/.local/share/tetris-agent/sessions`). Le modèle par défaut est `gpt-6.1-terra`; `TETRIS_MODEL` permet de le remplacer.

## Équipement par défaut

`profile.json` définit le profil livré. Au premier lancement, Tetris le lit comme valeur initiale; les modifications via `equipment add/remove` sont enregistrées dans `$XDG_CONFIG_HOME/tetris-agent/profile.json`, sans modifier le profil livré. `--profile PATH` sélectionne un profil explicite.

Le profil livré active 9 outils exécutables sur un budget de 12 :

- Fichiers workspace : `read_file`, `write_file`, `edit_file`.
- Recherche workspace : `glob_files`, `grep_files`.
- Shell approuvé : `shell`.
- Web public : `web_fetch`.
- Planification : `todo`.
- Délégation bornée : `task`.

Aucun `SKILL.md` OMP n'est copié ni activé dans ce profil. Les équipements par défaut sont des outils exécutables, déclarés dans des manifestes JSON. L'extension de skills reste facultative.

Craft Anything est optionnel. `tetris-agent equipment add craft` active `craft_chat` et `craft_report` si `craft-anything-cli` est installé; retirer le pack les désactive. Le wrapper Tetris utilise l'investigation profonde en lecture seule et n'accorde pas `--allow-run`.

## Modifier sans casser le profil

Consultez les packs avec `equipment list`. L'ajout d'un pack est atomique et refusé si une dépendance manque, si un slot est plein, si un conflit apparaît, si un tool/skill est dupliqué ou si le budget de 12 tools serait dépassé. Le retrait d'un pack requis par un autre pack actif est refusé.

Pour ajouter un skill personnalisé (optionnel et absent du profil par défaut) :

1. Créez `equipment/skills/<id>/SKILL.md` et ses références Markdown locales.
2. Ajoutez `equipment/skills/<id>/manifest.json` avec `id`, `name`, `description`, `slot: "skill"`, `tools: []`, `requires: ["skills-runtime"]` et une entrée `skills` dont `file` pointe vers le `SKILL.md` relatif.
3. Activez-le avec `tetris-agent equipment add <id>`.

Pour ajouter un nouveau tool, implémentez d'abord son handler dans `src/tools/` et raccordez-le dans `src/tools/index.js`; un manifeste seul ne peut pas exposer de code non implémenté. Le registre refusera les doublons et profils invalides. Gardez les tools de ce paquet Node dans son registre; le CLI natif Tetris conserve son runtime distinct.

## Permissions et limites

- Le shell s'exécute sans sandbox, dans le répertoire du workspace, après approbation explicite de chaque commande. Une approbation n'isole pas le processus : inspectez la commande avant de l'accepter.
- Les outils de fichiers limitent les chemins au workspace, refusent les écritures via symlink et écrivent atomiquement. La lecture est bornée à 200 lignes par défaut, 500 au maximum et 64 Kio de sortie.
- `web_fetch` ne lit que du texte HTTPS public; les adresses privées, les redirections dangereuses et les réponses trop grandes sont refusées.
- Le tool `task` crée un enfant sans délégation récursive; le mode recherche est en lecture seule et le mode implémentation ne reçoit que les outils actifs explicitement autorisés.
- `doctor` vérifie Node, `libfx`, le profil, le budget et la présence du login sans afficher de secret.

## Vérification

```sh
npm test
npm run verify
```

`npm run smoke` envoie deux tours Codex réels : le premier doit lire un fichier temporaire du workspace, le second reprend la session après redémarrage du runtime. Il nécessite un login Tetris (`tetris-agent login`); le scénario ne journalise ni le token de test ni les identifiants. `npm run verify` saute ce smoke réseau si aucun fichier d'identifiants Tetris n'existe.
