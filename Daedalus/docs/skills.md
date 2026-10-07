# Skills in Daedalus (hybrid model)

Daedalus skills are reusable instruction packs on disk (`SKILL.md` files).
They work **hybrid**: auto-detection finds them everywhere, and the user
keeps explicit control per workspace.

## Auto-detection (what the agent sees)

Every task scans, in precedence order (first skill with a given name
wins):

1. `<workspace>/.daedalus/skills` (origin `workspace`)
2. `~/.daedalus/skills` or `$DAEDALUS_HOME/skills` (origin `global`)
3. `$DAEDALUS_SKILLS_DIR` (origin `global`)
4. `~/.claude/skills` (origin `claude`)
5. `~/.codex/skills` / `$CODEX_HOME/skills` (origin `codex`)
6. `~/.config/opencode/skills`, `~/.opencode/skills` (origin `opencode`)
7. `~/.kilocode/skills` (origin `kilo`)

So skills you keep for Claude Code, Codex, OpenCode, or Kilo are visible
to Daedalus without copying anything.

The system prompt only carries an **index** of names + descriptions,
capped at **40** enabled skills. The model loads a full body on demand
with the `read_skill` tool (16K-char cap, same rendering as a tool
result). When more than 40 enabled winners exist, the prompt says so
(`+N more skills available — use read_skill by name`); the Web inventory
shows the same truth instead of hiding it.

## Per-workspace disablement (`.daedalus/skills.json`)

```json
{ "disabled": ["deploy", "legacy-migration"] }
```

- Disabling is **name-based**: a disabled name never loads in this
  workspace, from any origin — a shadowed same-name copy elsewhere does
  not resurrect it.
- Disabled skills are excluded from the registry, the prompt index, and
  `read_skill` (which answers "disabled for this workspace"), **before**
  the 40-cap — disabling frees index slots.
- A missing or corrupt config file degrades to **all-enabled**; a config
  problem can never crash a task.
- Global skills stay visible in every workspace until that workspace
  disables them.

Set it from any surface — they all write the same file:

- Web: Settings → Extensions → Skills toggles
- CLI: `daedalus skills enable|disable <name>` (and `daedalus skills list`
  shows the state)
- Chat: the activation chip (below) has a one-click disable

## Explicit invocation (`/skill <name>`)

Auto-matching depends on skill descriptions; when you know which skill a
task needs, force it:

- Web composer: `/skill <name> <task…>`, pick a name from the `/skill`
  completion menu, or send `/skill <name>` alone to stage it for the
  next prompt. The skill body is force-loaded into the task prompt,
  marked as user-invoked.
- CLI interactive: same `/skill` spellings. Non-interactive:
  `daedalus run --skill <name[,name…]> <task>`.

Naming an unknown or disabled skill **refuses visibly** (composer
warning, HTTP 400 from the gateway, run error) — a task never silently
runs without the skill you asked for.

## The activation chip ("why this fired")

Whenever a skill body enters a task's context, a `SKILL_LOADED` event is
recorded and rendered:

- Web chat: a compact chip — skill name, origin badge,
  **loaded by agent** (the model chose it via `read_skill`) vs
  **invoked by you**, and a one-click "disable for this workspace".
- CLI transcript: `✦ Skill loaded: deploy (claude — loaded by agent)`.

Chips never block, and a suppressed repeat `read_skill` does not
double-report.

## Bundled starter skills

Daedalus ships a small catalog of starter skills in `Daedalus/skills/`.
They are a *catalog*, not an install: `daedalus skills list` shows them,
`daedalus skills install <name>` (or `--all`) copies one into the
workspace skills directory, and only then does the loader see it. Nothing
bundled is loaded, indexed, or active by default.

The catalog: `code-review`, `git-workflow`, `spec-driven-development`,
`systematic-debugging`, `test-driven-development`, and `ponytail`.

**`ponytail`** is the lazy-senior-dev discipline: before writing code,
climb the ladder — does it need to exist, is it already in this codebase,
can the standard library / a native platform feature / an installed
dependency do it, can it be one line — then write the minimum that works,
with a "lazy about the solution, never about reading" guard and
`ponytail:` comments marking deliberate shortcuts. It is adapted from the
MIT-licensed Ponytail skill concept (provenance in
`docs/THIRD_PARTY.md`), ships **default-off**, and is enabled per
workspace exactly like any other skill: install it, then leave it enabled,
disable it in `.daedalus/skills.json`, or force-load it with
`/skill ponytail` for one task.

Prose-compression skills (caveman-style terse output) are deliberately
not bundled — Daedalus's token problem is tool output on the input side,
which the output compressor (`DAEDALUS_OUTPUT_COMPRESSION`) addresses. If
you want one anyway, drop any `SKILL.md` into a skills directory (for
example `<workspace>/.daedalus/skills/caveman/SKILL.md` or
`~/.claude/skills/`) and the loader picks it up like any other skill.

## Honest limits

- Matching quality still depends on each skill's `description` — the
  index is all the model sees until it chooses to load a body.
- The 40-skill index cap is real: disable unused skills to free slots.
- Disablement is per workspace and by name; there is no per-origin or
  global kill-switch (by design — disable where it hurts).
