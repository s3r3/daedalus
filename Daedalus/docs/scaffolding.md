# Scaffolding new projects

When a task asks Daedalus to create a **new** framework project — *"di
folder jojo itu buat project next js…"*, *"create a vite app"*, *"project
laravel baru"* — the agent loop does not improvise a skeleton. Core
detects the request deterministically and injects a **scaffold playbook**
into the task prompt (`## scaffold playbook`), mirroring how leading
harnesses bootstrap projects: preflight the toolchain, run the official
generator once with every prompt answered by flags, split scaffolding
from installing, and verify artifacts on disk before claiming done.

Implementation: `core/src/agent/scaffold.ts` (recipes + detection +
playbook), the toolchain probe and prompt injection in
`core/src/runtime.ts`, the completion gate in `core/src/agent/agent-loop.ts`
plus a lineage re-check in the runtime.

## Recipe table v2

### Framework and API generators

| Recipe | Category | Generator / bootstrap command (target dir substituted) | Marker required at completion |
| --- | --- | --- | --- |
| `nextjs` | framework | `npx -y create-next-app@latest <dir> --yes --skip-install --disable-git --ts --app --eslint --tailwind --src-dir --import-alias "@/*" --use-npm` | `<dir>/package.json` with a `next` dependency |
| `vite-react` | framework | `npm create vite@latest <dir> -- --template react-ts --no-interactive` | `<dir>/package.json` mentioning `vite` |
| `vite-vue` | framework | `npm create vite@latest <dir> -- --template vue --no-interactive` | `<dir>/package.json` mentioning `vite` |
| `angular` | framework | `npx --yes @angular/cli@latest new <dir> --defaults --interactive=false --skip-install --skip-git` | `<dir>/angular.json` |
| `laravel` | framework | `composer create-project laravel/laravel <dir> --no-interaction --prefer-dist` | `<dir>/artisan` |
| `flutter` | framework | `flutter create --project-name <snake_case> <dir>` | `<dir>/pubspec.yaml` mentioning `flutter` |
| `sveltekit` | framework | `npx -y sv@latest create <dir> --template minimal --types ts --no-add-ons --no-install` | `<dir>/package.json` mentioning `@sveltejs/kit` |
| `nuxt` | framework | `npx -y nuxi@latest init <dir> --template minimal --packageManager npm --no-install --no-gitInit` | `<dir>/nuxt.config.ts` |
| `astro` | framework | `npm create astro@latest <dir> -- --template minimal --no-install --no-git --skip-houston --yes` | `<dir>/astro.config.mjs` |
| `nestjs` | api | `npx --yes @nestjs/cli@latest new <dir> --package-manager npm --skip-git --skip-install --strict` | `<dir>/package.json` mentioning `@nestjs/core` |
| `django` | framework | `django-admin startproject <snake_case_project_name> <dir>` | `<dir>/manage.py` |
| `expo` | framework | `npx -y create-expo-app@latest <dir> --template blank-typescript --no-install --yes` | `<dir>/package.json` mentioning `expo` |
| `express` | api | `npm install express --prefix <dir> --no-audit --no-fund` | `<dir>/package.json` mentioning `express` |

The target dir comes from the goal ("di folder X", "in the X folder",
"folder bernama X"), sanitized to a relative path; it defaults to `app`.

### Database Compose recipes

Databases are not generated application projects. Each database recipe
writes one `docker-compose.yml` containing the official image, the
conventional port, a named data volume, and placeholder development
credentials, then starts it with `docker compose up -d` from the target
directory.

| Recipe | Category | Compose file written by the agent | Startup command | Marker required at completion |
| --- | --- | --- | --- | --- |
| `mysql` | database | `<dir>/docker-compose.yml` (`image: mysql:8.4`, port 3306, `mysql_data` volume) | `docker compose up -d` (cwd `<dir>`) | `<dir>/docker-compose.yml` mentioning `image: mysql` |
| `postgres` | database | `<dir>/docker-compose.yml` (`image: postgres:17`, port 5432, `postgres_data` volume) | `docker compose up -d` (cwd `<dir>`) | `<dir>/docker-compose.yml` mentioning `image: postgres` |
| `mongodb` | database | `<dir>/docker-compose.yml` (`image: mongo:8`, port 27017, `mongodb_data` volume) | `docker compose up -d` (cwd `<dir>`) | `<dir>/docker-compose.yml` mentioning `image: mongo` |
| `redis` | database | `<dir>/docker-compose.yml` (`image: redis:8`, port 6379, `redis_data` volume, append-only persistence) | `docker compose up -d` (cwd `<dir>`) | `<dir>/docker-compose.yml` mentioning `image: redis` |

A combined goal that names both an app/API framework and a database
uses the app/API recipe, because detection selects one primary recipe;
ask for the database stack as its own goal when it needs this separate
marker and startup step.

## Playbook contract (what the model is told)

- Run the generator **exactly once, in the foreground**, via `run_command`
  with `timeout_ms 600000`. Never explore the workspace first, never
  hand-write the framework skeleton.
- The flags answer every prompt (CI=true semantics; `npx` runs with
  `-y`). If a generator still asks a question, stop and report it instead
  of waiting for input that will never come.
- **Install is a separate step**: the generator skips installation on
  purpose (`--skip-install`); afterwards the model runs the install as
  its own `run_command` (also with `timeout_ms 600000`) inside the new
  project dir — or as a background job (`background: true`, then
  `command_status`; see "Background jobs") when the install is the slow
  part. The two phases are never fused, so a slow install cannot
  mask whether scaffolding itself succeeded.
- If the generated project ships `AGENTS.md` or docs, read them before
  writing code; then build the requested content **into** the generated
  structure — never as a parallel hand-made skeleton beside it.
- **Express is the bootstrap exception**: it has no project generator.
  Its npm command creates `package.json` when one is absent and installs
  Express into the target directory in the same step; the agent then
  writes the requested server code into that initialized project.
- **Database recipes do not run a project generator.** The agent writes
  the recipe's exact Docker Compose stack with `write_file`, runs
  `docker compose up -d` with `cwd` set to the target directory and
  `timeout_ms 600000`, then checks `docker compose ps`. If Docker itself
  is missing, the rendered playbook stops before writing the stack and
  tells the user Docker with Compose is required.

## Preflight

Before the loop starts, the runtime probes the recipe's toolchain **once
per task** (`node`/`npm`/`npx` for the JS recipes, `php`/`composer` for
Laravel, `flutter` for Flutter, `python3`/`django-admin` for Django, and
`docker` for the database Compose stacks) with a short `--version` call.
It also probes the **bootstrap routes** — `docker`, `mise`, `fnm`, `nvm`
— so the playbook knows how a missing toolchain could be acquired (see
the next section). A probe failure never blocks the task; the result
simply renders into the playbook, e.g. *"Toolchains on this machine:
node v20.11.0; npm 10.2.3; composer MISSING"*.

If a **needed** toolchain is missing, the playbook is explicit about the
sanctioned acquisition routes below, and stops honestly when none
exists. For the database recipes, missing Docker stops before a Compose
stack is written — Docker has no bootstrap route. Never hand-write a
fake framework skeleton (a hand-made `package.json`/config stub
pretending to be a generated project) — the completion gate below
treats that as no creation anyway.

## When the toolchain is missing (bootstrap routes)

A missing toolchain is no longer automatically a dead end. When the
preflight finds a recipe's binaries missing, the playbook renders an
acquisition section — sanctioned routes, in priority order, **user-level
only**: the agent is never instructed to use a system package manager or
admin rights to install a toolchain.

1. **Container route (preferred when Docker exists)** — the SAME
   generator runs in the toolchain's official Docker image, with the
   workspace mounted at `/work` and `--user <uid:gid>` so generated
   files stay owned by the user, never root:

   ```text
   docker run --rm --user 1000:1000 -e HOME=/tmp -v <workspace>:/work -w /work node:22 npx -y create-next-app@latest jojo …
   ```

   Images are official, major-version tags only: `node:22` (every
   node/npm/npx recipe), `composer:2` (Laravel), `cirruslabs/flutter:stable`
   (Flutter), `python:3.12` (Django, which installs Django inside the
   container before `startproject`). The first pull downloads the image
   and is slow — the command runs with `timeout_ms 600000` or as a
   background job. Files land in the workspace exactly as a host run, so
   the on-disk marker check is unchanged; if dependencies still need
   installing while the host toolchain is missing, the install runs in
   the container the same way.
2. **Version-manager route (no Docker)** — a user-level version manager
   installs the toolchain, then the host generator runs exactly as
   written: `mise use --global node@22` (npm/npx ride along), `php@8.3`,
   `python@3.12`, `flutter@stable`; `fnm install 22` / `nvm install 22`
   when only a node manager exists. The model must verify
   `<tool> --version` afterwards and report a failed install plainly.
3. **Honest STOP** — when neither Docker nor a version manager exists,
   the playbook stops and names what the user can install (Docker, or
   mise for user-level toolchains). Nothing is installed any other way.

Trust notes: only official image names + major-version tags are ever
rendered; generation stays non-interactive inside the container, so
toolchains whose installers demand interactive license acceptance
(Android SDK) remain impossible here and stay honesty-only. The
database recipes are the exception that proves the rule: Docker is their
runtime, not their bootstrap, so a missing Docker still stops before
any stack is written.

## Completion gate (blocking, narrow)

A creation-shaped run may not report success over nothing. The gate keys
only on creation-shaped goals — a conservative matcher (Indonesian +
English creation verbs + an artifact noun, or a scaffold recipe).
Questions/explanations (leading question word, trailing `?`) and fixes
to existing files never trip it; read-only investigations and no-change
refactors keep their normal outcomes.

Enforcement, two layers with one shared decision function:

1. **Agent loop (per task)** — when a run reaches completion (all steps
   done, or an explicit `done:` claim) with zero creation evidence:
   - evidence = file-tool changes (`write_file`/`edit_file`/`create_dir`,
     including folders), successful `run_command` executions, and — for
     scaffold goals — the recipe marker present on disk under the
     target.
   - First refusal spends **one repair turn**: the model is told exactly
     what is missing (e.g. *"the scaffold marker package.json was not
     found under jojo/"*) and sent back to create it.
   - A second empty finish fails the task with reason `no_files_created`.
2. **Runtime (lineage)** — the loop delegates with an empty own ledger by
   design, so after the loop the runtime re-counts across the whole run
   (children's file changes included). A "success" with zero lineage
   evidence is demoted to `partial`. Either way the report carries the
   evidence line: *"no files were created: … the run ended after N
   turn(s), M tool call(s), …"*.

Ask and Plan modes are exempt (Ask answers questions; Plan's deliverable
is the plan document, guarded separately).

## Looking it up instead of guessing (fetch_url)

Frameworks **without** a verified recipe (the honesty playbook:
Kotlin/Android, embedded SQLite, and anything else the tables don't
cover) are no longer a dead end of model memory. The playbook now orders
the model to look the installation up before building:

1. **`fetch_url` the official install/docs page** — Daedalus's read-only
   web tool. The model supplies the exact docs URL from its knowledge;
   the tool returns the page as readable text (HTML stripped, plain
   text/markdown verbatim, 12,000-char cap with a truncation note).
2. **Fall back to `<generator> --help`** via `run_command` when the fetch
   fails or the page doesn't cover installation.
3. **Never invent install steps** and present them as verified — if
   neither source answers, the model says so plainly.

`fetch_url` rules: http/https only; at most 3 redirects; 15s timeout;
bodies must be readable text (HTML/text/markdown/JSON), and literal
private/loopback/link-local hosts are refused up front and re-checked on
every redirect (127.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
`::1`, `localhost`). There is **no search engine** behind it — Daedalus
holds no search API key, so the model must know the docs URL. Honest
limits: pages that render mostly with JavaScript may yield little text,
and DNS answers are not inspected, so a public hostname that resolves to
a private address is outside the implemented guard layer. The tool is
registered in every mode (Ask included) alongside the other reads. Full
tool reference: `docs/mcp-skills-lsp.md` ("Built-in web and vision
reads").

The same batch's edit-side feedback — fresh LSP diagnostics appended to
`write_file`/`edit_file`/`edit_search_replace`/`create_dir` results (≤20
lines, `+N more` rollup, bounded and fail-silent) — is documented with
the LSP wiring in `docs/mcp-skills-lsp.md`.

## Images for the thing you just built (search_images + download_file)

A scaffolded page usually needs a real picture (a person's photo, a
place, a product). The image pair — `search_images` over the anonymous,
keyless Openverse + Wikimedia Commons catalogues, then `download_file`
into the workspace with its attribution sidecar — is documented with the
other web/vision tools in `docs/mcp-skills-lsp.md` ("Built-in web and
vision reads"). The contract there applies here too: download first
(never hotlink), `view_image` the saved file to confirm it matches the
page's subject, and never substitute a generated image for a real named
person's photo.

## Long commands

`run_command` accepts an optional `timeout_ms` (clamped to the 600 s tool
cap; the default short budget is unchanged). Generator and install
commands use it via the playbook + tool description. Output keeps
streaming through the existing `COMMAND_OUTPUT` events while the command
runs, so long installs show progress — no new mechanism was needed.

## Background jobs

Work that must outlive one tool call — package installs, dev servers,
image pulls — runs as an agent-owned background job instead of blocking
the loop foreground (the Claude Bash / Codex exec / Crush job shape):

- **`run_command` with `background: true`** starts the process and
  returns a job handle immediately (`started background job job-1: npm
  install …`). The same allowlist, cwd confinement, and approval
  classification apply: the start is the execution the user approves
  (once, at dispatch, in Manual); Ask/Plan deny it like any command.
  Never the shell's `&` — the process group, output, and lifetime are
  managed, not orphaned.
- **`command_status`** (read-only, every mode) polls one job: state
  (`running`/`exited`/`failed`/`killed`), exit code, and the bounded
  tail of recent output (default 1,000 chars, 4,000 max). The scaffold
  playbook's etiquette: poll between other work, never in a tight loop —
  the anti-loop guard deliberately never suppresses `command_status`,
  since its answer changes while its arguments do not.
- **`command_kill`** (execution class, exactly like `run_command`:
  denied in Ask/Plan, approval-gated in Manual) terminates the job's
  whole process group; killing a finished job is a report, not an error.

At most **3 jobs run concurrently per task** (a fourth start is refused
with the running count). Jobs are owned by the task that started them:
**task end and Stop kill whatever is still running**, and the runtime
emits `JOB_STARTED` / `JOB_FINISHED` events (CLI and Web render both,
and the Web agent terminal mirrors the job's `COMMAND_OUTPUT`, tagged
with the job id). Jobs live in memory in the server process — they die
when it does; if the server is killed ungracefully, a detached job
process can outlive it (documented limit, same as any daemon child).
User-side server terminal sessions (`docs/terminal.md`) are unchanged:
they belong to the human, run unbounded, and the agent never touches
them.

## Honest limits

- **React Native support is the Expo path.** React Native goals use the
  verified `create-expo-app` recipe; the bare React Native CLI is not a
  separate recipe. Kotlin/Android still has no verified generator flow
  (no Gradle/Android SDK preflight), so a goal naming it gets the
  honesty playbook instead: don't fake a skeleton, scaffold a supported
  part if one applies, otherwise say plainly what's missing and ask.
- **SQLite has nothing to scaffold or install.** SQLite is an embedded
  database file the application opens directly; Daedalus treats it as an
  honesty-only mention and the agent should add a SQLite driver to an
  existing app project rather than inventing a database project.
- **Missing toolchain = bootstrap, then honest stop.** If `composer`/
  `flutter`/`django-admin`/… is not on the machine, the agent acquires
  it via the container route (Docker) or a user-level version manager
  (mise/fnm/nvm) — never a system package manager, never admin rights —
  and only stops, saying so plainly, when neither route exists. For
  database recipes, missing Docker still stops before a Compose stack
  is written: Docker itself has no user-level bootstrap.
- **Database markers prove the Compose artifact, not a healthy server.**
  The gate requires `docker-compose.yml` with the right official image
  under the target directory; it does not prove the Docker daemon
  accepted the stack or that the container stayed healthy. The playbook
  therefore requires `docker compose up -d` plus `docker compose ps`,
  and daemon failures must be reported instead of claimed as running.
- **Compose credentials are development placeholders.** Every database
  stack uses `change-me-before-real-use` passwords that must be changed
  before any real deployment.
- The marker check is **presence evidence, not a build**: a `package.json`
  with a `next` dependency proves a generator-shaped project exists; it
  does not prove the app compiles (validation still owns that).
- Files created purely by shell redirection outside a recipe marker
  (`echo … > file`) leave no per-file diff; a successful `run_command`
  counts as creation evidence for non-scaffold goals, but the gate
  cannot enumerate those files individually.
- Foreground installs and generators are capped at **600 s**; longer
  work belongs in a background job (still task-owned: it dies at task
  end). The first `docker pull` of a toolchain image counts against the
  same patience — a cold machine bootstraps slower than a warm one.
