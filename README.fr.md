# token-eco

*[English version](README.md)*

Un plugin Claude Code personnel qui cherche à réduire la consommation de tokens (voir **Benchmarks** pour ce qu'il
obtient et n'obtient pas). Il apporte :

- un **serveur MCP** d'outils de fichiers économes en tokens ;
- une courte **consigne de session** (hook SessionStart) pour que l'agent par défaut les utilise et groupe ses appels ;
- un agent strict optionnel `eco` (plus `eco-explore`, un explorateur en lecture seule peu coûteux, sur Haiku) ;
- un **hook PreToolUse** pour tous les agents : sorties Bash compactées, appels Read/Grep coûteux redirigés ;
- un **dashboard web local**, par projet, et un résumé dans le terminal des économies (**estimées**).

## Outils MCP

| Outil | Ce qu'il fait | Référence « native » utilisée pour l'estimation |
|---|---|---|
| `read` | `name` → le code de ce symbole (doc, `template <…>`, surcharges ; définition préférée au prototype) ; `start`/`end` → plage ; `pattern` → lignes du fichier qui correspondent, avec contexte ; rien → fichier entier s'il est court, sinon un plan ; `targets` → jusqu'à 20 lectures en un appel (plafond ≈ 10K tokens) | fichier entier / Read de la même plage |
| `search` | regex groupée par fichier, totaux exacts ; `mode` `lines`/`files`/`count` ; `symbols: true` → chaque résultat étiqueté avec sa fonction/classe englobante (`› name L12-30`) ; `expand: true` → toute la fonction/classe englobante de chaque résultat (≤ 150 lignes chacune, ≈ 6K tokens par recherche) : recherche + lecture en un appel ; `queries` → jusqu'à 10 recherches en un appel ; pas de `pattern` + `glob` = liste de fichiers | mêmes lignes au format `grep -rn` (+ Read des plages étendues) |
| `edit` | N remplacements exacts (`old_string`/`new_string`/`replace_all`) en un appel, tout ou rien ; si un texte est introuvable, l'erreur montre le passage le plus proche (autre indentation, ligne correspondante, mots communs) à recopier tel quel | extraits renvoyés par N appels `Edit` natifs |
| `eco_report` | résumé des économies ; `dashboard: true` lance le dashboard | – |

**Pourquoi grouper** : chaque appel d'outil est un tour complet qui relit tout le contexte depuis le cache du prompt
(≈ 75K tokens par tour dans une vraie session) ; le nombre d'appels pèse donc plus sur le coût que la taille de chaque
résultat. Tous les outils acceptent des lots, et la consigne de session les demande.

**Par défaut : agent principal strict `eco`** (`settings.json` → `"agent": "token-eco:eco"`). Dans les sessions réelles
mesurées, il a traité 6 à 10 % de tokens de moins que Claude Code seul (contexte plus petit, moins de lectures de cache),
alors que le mode « outils seuls » non (voir Benchmarks) ; le coût en dollars était à peu près le même car il écrivait
plus. Pour garder ton agent habituel (il reçoit quand même les outils, la consigne de 5 lignes et le hook), retire la
ligne `"agent"` du `settings.json` du plugin. L'agent `eco` n'a ni Read/Grep/Glob/Edit/NotebookEdit natifs, ni les outils
d'automatisation/distants rarement utilisés (Cron*, DesignSync, worktrees, PushNotification, RemoteTrigger,
ReportFindings, ScheduleWakeup, SendMessage, Workflow, ListAgents). Mesuré : tourner en agent personnalisé coûte ~5K
tokens de prompt en plus par session ; avec ces retraits, le préfixe d'eco fait 39,3K tokens contre 40,0K pour Claude Code
seul (44,2K avant). Il garde Task, Bash, Write, WebFetch, WebSearch, Monitor, TaskStop, Skill et ToolSearch. Pour
récupérer un outil retiré, supprime-le de `disallowedTools` dans `agents/eco.md`. `alwaysLoad: true` : outils chargés
d'emblée, pas de tour `ToolSearch`.

## Hook (tous les agents, y compris les tiens)

- **Sorties Bash compactées** : tests, builds, installations et commandes git sont réécrits de façon transparente vers
  `server/dist/run.js` (code de sortie conservé ; erreurs et échecs toujours conservés). Détecte les outils lancés via
  `.venv/bin/`, `node_modules/.bin/`, `uv run`/`poetry run`, `python -m`. Dans des enchaînements comme
  `cd x && pytest -q; git status` (`;`, `&&`, `||`), chaque partie bavarde est réécrite et les autres gardées telles
  quelles ; `| tail -N`, `| head -N` et `2>&1` sont gérés. Les permissions sont respectées : une règle deny sur une
  partie → rien n'est réécrit ; toutes les parties autorisées (ou git status/log/diff/show, `cd`) → autorisé ; sinon
  Claude Code demande comme d'habitude. Tout ce qui contient `$(…)`, des backticks, des heredocs, `( )`/`{ }`, des
  boucles/conditions, un `&` en arrière-plan ou des modes watch/dev est laissé tel quel.
- **Read d'un gros fichier** (> 300 lignes, sans offset/limit) → refusé une fois, et le message contient le plan (pas de
  tour perdu). **Grep en mode `content`** → refusé une fois, avec un renvoi vers `search`. Le même appel répété dans les
  10 minutes passe, donc un agent sans les outils token-eco n'est jamais bloqué.
- `/eco-adopt [agent…]` : ajoute les outils token-eco et un court bloc de consignes à tes agents qui ont une liste
  `tools:` restreinte (demande confirmation, garde des copies `.bak`).

## Installation

Nécessite Node ≥ 22.13 (`node:sqlite`). `server/dist/` est commité, rien à compiler.

```
/plugin marketplace add budocay/token-eco
/plugin install token-eco@token-eco-marketplace
```
Depuis un clone local : `/plugin marketplace add /chemin/vers/token-eco`.
Redémarre Claude Code et vérifie avec `/mcp` que le serveur `token-eco` est connecté.

## Utilisation

- `/eco-stats` : résumé dans le terminal : estimations par appel (aujourd'hui, 7 jours, total, par outil, par projet) et
  les **sessions réelles** des 30 derniers jours d'après les logs Claude Code (tokens par tour et par session, avec vs
  sans token-eco).
- `/eco-dashboard` : lance le dashboard sur `http://127.0.0.1:4777` et ouvre le navigateur.
- `/eco-statusline` : les économies dans la barre d'état de Claude Code.
- Hors de Claude Code : `node server/dist/cli.js <stats|statusline|dashboard|serve|stop>`.

**Dashboard** : barre latérale des projets (tous, ou un seul, triés par dernière activité, une couleur chacun), période
7 j/30 j/90 j/Tout, choix du modèle pour les tarifs, indicateurs (estimations par appel : dollars, tokens évités,
réduction, appels), une partie **Sessions réelles** (vrais tokens par tour / par session et coût d'après les logs Claude
Code, avec vs sans token-eco, sessions récentes), graphique quotidien empilé par projet (ou par outil dans un projet)
avec légende cliquable, barres par outil et par projet, carte des tarifs, compteurs du hook, appels récents filtrables.
Un projet = son dépôt git principal : sous-dossiers et worktrees git y sont regroupés, et la vue d'un projet a une carte
**Worktrees et dossiers** ; les dossiers de benchmark/temporaires (`excludeProjects`) restent hors de la barre latérale.
Thème clair/sombre/auto, choix de langue **EN/FR** (par défaut celle du navigateur). N'écoute que sur 127.0.0.1 et
rejette les en-têtes `Host` étrangers.

## Tarifs et estimations

- Prix : table officielle d'Anthropic dans `server/src/pricing.ts` (USD par million de tokens, MTok ; vérifiée le
  2026-10-22).
- Un résultat d'outil est écrit une fois dans le cache du prompt (écriture 5 minutes), puis relu depuis le cache à chaque
  tour suivant. Un token économisé vaut donc `cacheWrite5m + laterTurns × cacheRead`. Par défaut : Claude Sonnet 5.5,
  10 tours suivants → 2,50 $ + 10 × 0,10 $ = **3,50 $ par MTok économisé**.
- Les tokens sont estimés à 1 token ≈ 4 caractères (`server/src/tokens.ts`, seul endroit à modifier).
- Non compté : les allers-retours évités, ni la lecture complète préalable qu'exige l'`Edit` natif.
- Affichage : tokens en `950`, `12.3K`, `4.56M` (valeur exacte au survol) ; dollars en `$1.23`, `<$0.01` (en français
  dans le dashboard : `1,23 $`).

## Données et configuration

Tout est dans `~/.token-eco/` (modifiable avec `TOKEN_ECO_HOME`) :
- `eco.db` (SQLite) : une ligne par appel (`ts`, `project` = dépôt git principal, `workdir` = dossier exact, `tool`,
  `returned_tokens`, `native_tokens_est`, `duration_ms`, `details`) et les `redirections` du hook. Les anciennes bases
  sont migrées sur place automatiquement.
- `projects.json` : cache dossier → dépôt git principal.
- `config.json` : `model` (une clé de `pricing.ts`, ex. `claude-opus-5.5`, ou `auto`), `laterTurns`, `port`,
  `excludeProjects`, `hook: { mode: "redirect" | "off", lineThreshold: 300 }`, `lang` (`auto` | `en` | `fr` : langue de
  `/eco-stats` et de la barre d'état ; `auto` suit `LANG`). Les anciennes clés sont migrées automatiquement.

## Benchmarks

Les rapports sont générés en local et ne sont pas commités.

**Hors ligne** (`cd server && npm run bench`, gratuit → `server/bench/RESULTS.md`) : sortie des outils comparée au vrai
arbre syntaxique (compilateur TypeScript, `ast` Python) sur zod, ajv, le SDK MCP et la stdlib Python (~260 fichiers,
2 600 symboles) :

| | TypeScript | JavaScript | Python |
|---|---|---|---|
| plan : déclarations trouvées / lignes pertinentes | 96 % / 92 % | 100 % / 98 % | 100 % / 98 % |
| plan : taille vs Read natif (médiane) | 10 % | 6 % | 8 % |
| lecture de symbole : bloc exact / bon début | 92 % / 99 % | 100 % / 100 % | 100 % / 100 % |
| lecture de symbole : taille vs Read natif | 5 % | 9 % | 4 % |

`search` donne exactement les mêmes résultats que `grep` (10 motifs sur 10) pour environ 47 % des tokens de `grep -rn`.
Résultats multi-langages (vérité terrain ctags) : `node bench/languages.ts` → `server/bench/LANGUAGES.md`.

**A/B réel** (`npm run bench:ab -- --model sonnet --trials 4 [--tasks t4,t5]`, payant, plafonné par `--budget`) : lance
les mêmes tâches dans `claude -p` avec et sans le plugin et compare coût réel, contexte, tours et réussite →
`server/bench/AB.md`. Désactive d'abord le plugin installé. Résultats (Sonnet) : v0.3 (t1-t5 × 4) eco −8 % de coût
(≈ −10 % sans le biais du cache froid, désormais supprimé par un échauffement non compté ; `--no-warmup` pour le
sauter) ; v0.4.1 (t4, t5 × 4) −10 % de coût, 16/16 réussites, −20 % de contexte. Plancher ≈ −10 % sur les tâches courtes
(coût fixe du prompt).

**Sessions réelles** (`node bench/session-cost.ts <dir> <dir>… [--latest] [--cold]` : coût réel d'après les logs de
session Claude Code, sous-agents compris ; `--cold` retire le biais du cache chaud au premier tour). Une session en
6 étapes sur click 8.5.0 (explorer, corriger un bug, ajouter un type, renommer dans plusieurs fichiers, relire avec un
sous-agent, changelog), Sonnet 5.5, mêmes prompts, cache chaud, 9 contrôles d'acceptation cachés. Coût vs Claude Code
seul :

| Run | token-eco (outils, défaut) | agent strict token-eco |
|---|---|---|
| 1 (v0.4, corrigé cache froid) | +17 % | – |
| 2 (v0.4) | −7 % | – |
| 3 (v0.5.0) | 0 % | −5 % |
| 4 (v0.5.1) | +22 % | +6 % |
| 5 (v0.5.3, **Opus 5.5**) | −1 % (tokens −14 %) | **−13 %** (tokens −32 %, 27 tours contre 37) |

Toutes les sessions ont passé 9/9. Tokens réellement traités (toutes lectures/écritures de cache + sortie) : l'agent
strict a utilisé −10 % (run 3) et −6 % (run 4) ; le mode outils seuls +4 % et +29 %.

**Conclusion honnête : pas d'économie mesurable en dollars sur des sessions réelles avec Sonnet 5.5 ; une économie de
tokens modeste avec l'agent strict (2 runs, à confirmer). Avec Opus 5.5, l'agent strict a économisé 13 % du coût et 32 %
des tokens (1 run, à confirmer) :** Opus seul lit des fichiers entiers (18 Read, 17 Edit dans cette session) là où Sonnet
seul utilise `grep`/`sed`, donc les outils ciblés ont plus à économiser. Les lectures de cache sont bon marché
(0,10 $/MTok), donc moins de tokens fait à peine bouger la facture, mais ça compte pour les limites d'abonnement et la
longueur du contexte. Sonnet seul lit déjà sobrement (`grep -A`, `sed -n` enchaînés dans un seul appel Bash) ; le coût
dépend du nombre de tours, que le plugin ne réduit pas de façon fiable, et la variance d'une session à l'autre (±15 %)
dépasse tout effet. Là où il aide de façon mesurable : tâches courtes et ciblées (−10 % dans l'A/B ci-dessus), très
longues sorties de tests/builds (compaction Bash), lectures complètes de très gros fichiers (redirigées vers un plan),
et le dashboard d'usage. Leçons transformées en correctifs : search garde l'indentation (recopiée dans les edits), et
les lots `edit` en échec montrent le passage le plus proche, pour que la nouvelle tentative tienne en un appel.

## Développement

```
cd server && npm install
npm test               # node:test
npm run typecheck
npm run build          # bundle esbuild → dist/index.js (MCP), cli.js, hook.js, run.js
```
Commite `server/dist/` après un build : le plugin tourne depuis ce dossier.

## Licence

Projet personnel, fourni tel quel. MIT (voir `LICENSE`).
