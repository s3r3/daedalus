import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Scaffold playbook: deterministic recipes for creating NEW framework
 * projects with the official generator, plus the goal classification that
 * backs the completion gate.
 *
 * The incident this module answers: a task like "di folder jojo itu buat
 * project next js buat halaman website tentang biodata presiden putin"
 * ended in "Selesai" with no project on disk — the model listed folders,
 * timed out twice, and never ran a generator. Leading harnesses all do
 * the same four things instead: preflight the toolchain, run the official
 * generator once with every prompt answered by explicit flags, split
 * scaffolding from installing, and verify artifacts on disk before
 * claiming done. This module is the Daedalus-shaped version of that:
 * detection + playbook rendering here, preflight in the runtime, and a
 * blocking completion gate (agent loop + runtime recheck) that refuses a
 * creation-shaped run which produced no files.
 */

export type ScaffoldRecipeId =
  | 'nextjs'
  | 'vite-react'
  | 'vite-vue'
  | 'angular'
  | 'laravel'
  | 'flutter'
  | 'sveltekit'
  | 'nuxt'
  | 'astro'
  | 'nestjs'
  | 'django'
  | 'expo'
  | 'express'
  | 'mysql'
  | 'postgres'
  | 'mongodb'
  | 'redis';

export type ScaffoldRecipeCategory = 'framework' | 'api' | 'database';

export type ScaffoldRecipe = {
  id: ScaffoldRecipeId;
  framework: string;
  category: ScaffoldRecipeCategory;
  /** Binaries the preflight probes for this recipe. */
  toolchains: string[];
  /** Generator argv (command + args) for a target dir, plus the display line. */
  generator: (targetDir: string) => { command: string; args: string[]; display: string };
  /**
   * File that must exist under the target dir before a scaffold run may
   * claim success. `mustContain` narrows it (e.g. a Next.js package.json
   * must actually depend on `next`).
   */
  marker: { path: string; mustContain?: string };
  /** The separate install step run after scaffolding (--skip-install split). */
  installHint: string;
  /** True when the generator command already performs the dependency install. */
  generatorInstallsDependencies?: boolean;
  /**
   * Bootstrap route when the host toolchain is missing: run the same
   * generator in the official toolchain image (Docker), with the
   * workspace mounted at /work. `generator` defaults to the host
   * generator; only recipes whose in-container command differs
   * (Django: install Django first) override it. Database recipes have
   * no container route — Docker is their runtime, not their bootstrap.
   */
  container?: {
    image: string;
    generator?: (targetDir: string) => { command: string; args: string[]; display: string };
  };
  /** Database recipes only: the Compose stack the agent writes before starting it. */
  composeFile?: { path: string; content: (targetDir: string) => string };
};

export const SCAFFOLD_RECIPES: Record<ScaffoldRecipeId, ScaffoldRecipe> = {
  nextjs: {
    id: 'nextjs',
    framework: 'Next.js',
    category: 'framework',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['-y', 'create-next-app@latest', dir, '--yes', '--skip-install', '--disable-git', '--ts', '--app', '--eslint', '--tailwind', '--src-dir', '--import-alias', '@/*', '--use-npm'],
      display: `npx -y create-next-app@latest ${dir} --yes --skip-install --disable-git --ts --app --eslint --tailwind --src-dir --import-alias "@/*" --use-npm`,
    }),
    marker: { path: 'package.json', mustContain: 'next' },
    installHint: `npm install (inside ${'${dir}'})`,
    container: { image: 'node:22' },
  },
  'vite-react': {
    id: 'vite-react',
    framework: 'Vite + React (TypeScript)',
    category: 'framework',
    toolchains: ['node', 'npm'],
    generator: (dir) => ({
      command: 'npm',
      args: ['create', 'vite@latest', dir, '--', '--template', 'react-ts', '--no-interactive'],
      display: `npm create vite@latest ${dir} -- --template react-ts --no-interactive`,
    }),
    marker: { path: 'package.json', mustContain: 'vite' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  'vite-vue': {
    id: 'vite-vue',
    framework: 'Vite + Vue',
    category: 'framework',
    toolchains: ['node', 'npm'],
    generator: (dir) => ({
      command: 'npm',
      args: ['create', 'vite@latest', dir, '--', '--template', 'vue', '--no-interactive'],
      display: `npm create vite@latest ${dir} -- --template vue --no-interactive`,
    }),
    marker: { path: 'package.json', mustContain: 'vite' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  angular: {
    id: 'angular',
    framework: 'Angular',
    category: 'framework',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['--yes', '@angular/cli@latest', 'new', dir, '--defaults', '--interactive=false', '--skip-install', '--skip-git'],
      display: `npx --yes @angular/cli@latest new ${dir} --defaults --interactive=false --skip-install --skip-git`,
    }),
    marker: { path: 'angular.json' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  laravel: {
    id: 'laravel',
    framework: 'Laravel',
    category: 'framework',
    toolchains: ['php', 'composer'],
    generator: (dir) => ({
      command: 'composer',
      args: ['create-project', 'laravel/laravel', dir, '--no-interaction', '--prefer-dist'],
      display: `composer create-project laravel/laravel ${dir} --no-interaction --prefer-dist`,
    }),
    marker: { path: 'artisan' },
    installHint: 'composer install (inside the project dir)',
    container: { image: 'composer:2' },
  },
  flutter: {
    id: 'flutter',
    framework: 'Flutter',
    category: 'framework',
    toolchains: ['flutter'],
    generator: (dir) => ({
      command: 'flutter',
      args: ['create', '--project-name', flutterProjectName(dir), dir],
      display: `flutter create --project-name ${flutterProjectName(dir)} ${dir}`,
    }),
    marker: { path: 'pubspec.yaml', mustContain: 'flutter' },
    installHint: 'flutter pub get (inside the project dir)',
    container: { image: 'cirruslabs/flutter:stable' },
  },
  sveltekit: {
    id: 'sveltekit',
    framework: 'SvelteKit',
    category: 'framework',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['-y', 'sv@latest', 'create', dir, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install'],
      display: `npx -y sv@latest create ${dir} --template minimal --types ts --no-add-ons --no-install`,
    }),
    marker: { path: 'package.json', mustContain: '@sveltejs/kit' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  nuxt: {
    id: 'nuxt',
    framework: 'Nuxt',
    category: 'framework',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['-y', 'nuxi@latest', 'init', dir, '--template', 'minimal', '--packageManager', 'npm', '--no-install', '--no-gitInit'],
      display: `npx -y nuxi@latest init ${dir} --template minimal --packageManager npm --no-install --no-gitInit`,
    }),
    marker: { path: 'nuxt.config.ts' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  astro: {
    id: 'astro',
    framework: 'Astro',
    category: 'framework',
    toolchains: ['node', 'npm'],
    generator: (dir) => ({
      command: 'npm',
      args: ['create', 'astro@latest', dir, '--', '--template', 'minimal', '--no-install', '--no-git', '--skip-houston', '--yes'],
      display: `npm create astro@latest ${dir} -- --template minimal --no-install --no-git --skip-houston --yes`,
    }),
    marker: { path: 'astro.config.mjs' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  nestjs: {
    id: 'nestjs',
    framework: 'NestJS API',
    category: 'api',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['--yes', '@nestjs/cli@latest', 'new', dir, '--package-manager', 'npm', '--skip-git', '--skip-install', '--strict'],
      display: `npx --yes @nestjs/cli@latest new ${dir} --package-manager npm --skip-git --skip-install --strict`,
    }),
    marker: { path: 'package.json', mustContain: '@nestjs/core' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  django: {
    id: 'django',
    framework: 'Django',
    category: 'framework',
    toolchains: ['python3', 'django-admin'],
    generator: (dir) => ({
      command: 'django-admin',
      args: ['startproject', djangoProjectName(dir), dir],
      display: `django-admin startproject ${djangoProjectName(dir)} ${dir}`,
    }),
    marker: { path: 'manage.py' },
    installHint: 'Django itself is the preflighted Python toolchain; run python3 manage.py migrate only after the generated settings are reviewed',
    container: {
      image: 'python:3.12',
      generator: (dir) => ({
        command: 'sh',
        args: ['-c', `python3 -m pip install --quiet django && django-admin startproject ${djangoProjectName(dir)} ${dir}`],
        display: `sh -c "python3 -m pip install --quiet django && django-admin startproject ${djangoProjectName(dir)} ${dir}"`,
      }),
    },
  },
  expo: {
    id: 'expo',
    framework: 'Expo / React Native',
    category: 'framework',
    toolchains: ['node', 'npm', 'npx'],
    generator: (dir) => ({
      command: 'npx',
      args: ['-y', 'create-expo-app@latest', dir, '--template', 'blank-typescript', '--no-install', '--yes'],
      display: `npx -y create-expo-app@latest ${dir} --template blank-typescript --no-install --yes`,
    }),
    marker: { path: 'package.json', mustContain: 'expo' },
    installHint: 'npm install (inside the project dir)',
    container: { image: 'node:22' },
  },
  express: {
    id: 'express',
    framework: 'Express API',
    category: 'api',
    toolchains: ['node', 'npm'],
    generator: (dir) => ({
      command: 'npm',
      args: ['install', 'express', '--prefix', dir, '--no-audit', '--no-fund'],
      display: `npm install express --prefix ${dir} --no-audit --no-fund`,
    }),
    marker: { path: 'package.json', mustContain: 'express' },
    installHint: 'The npm command above initializes package.json if one is absent and installs Express in the target directory; then write the requested server code into that project',
    generatorInstallsDependencies: true,
    container: { image: 'node:22' },
  },
  mysql: {
    id: 'mysql',
    framework: 'MySQL via Docker Compose',
    category: 'database',
    toolchains: ['docker'],
    generator: (dir) => ({
      command: 'docker',
      args: ['compose', 'up', '-d'],
      display: `docker compose up -d (with cwd ${dir})`,
    }),
    composeFile: {
      path: 'docker-compose.yml',
      content: () => [
        'services:',
        '  mysql:',
        '    image: mysql:8.4',
        '    restart: unless-stopped',
        '    environment:',
        '      MYSQL_ROOT_PASSWORD: "change-me-before-real-use"',
        '      MYSQL_DATABASE: app',
        '      MYSQL_USER: app',
        '      MYSQL_PASSWORD: "change-me-before-real-use"',
        '    ports:',
        '      - "3306:3306"',
        '    volumes:',
        '      - mysql_data:/var/lib/mysql',
        '',
        'volumes:',
        '  mysql_data:',
        '',
      ].join('\n'),
    },
    marker: { path: 'docker-compose.yml', mustContain: 'image: mysql' },
    installHint: 'Docker Compose pulls the official MySQL image and creates the named volume on first start; no host MySQL install is part of this recipe',
  },
  postgres: {
    id: 'postgres',
    framework: 'PostgreSQL via Docker Compose',
    category: 'database',
    toolchains: ['docker'],
    generator: (dir) => ({
      command: 'docker',
      args: ['compose', 'up', '-d'],
      display: `docker compose up -d (with cwd ${dir})`,
    }),
    composeFile: {
      path: 'docker-compose.yml',
      content: () => [
        'services:',
        '  postgres:',
        '    image: postgres:17',
        '    restart: unless-stopped',
        '    environment:',
        '      POSTGRES_USER: app',
        '      POSTGRES_PASSWORD: "change-me-before-real-use"',
        '      POSTGRES_DB: app',
        '    ports:',
        '      - "5432:5432"',
        '    volumes:',
        '      - postgres_data:/var/lib/postgresql/data',
        '',
        'volumes:',
        '  postgres_data:',
        '',
      ].join('\n'),
    },
    marker: { path: 'docker-compose.yml', mustContain: 'image: postgres' },
    installHint: 'Docker Compose pulls the official PostgreSQL image and creates the named volume on first start; no host PostgreSQL install is part of this recipe',
  },
  mongodb: {
    id: 'mongodb',
    framework: 'MongoDB via Docker Compose',
    category: 'database',
    toolchains: ['docker'],
    generator: (dir) => ({
      command: 'docker',
      args: ['compose', 'up', '-d'],
      display: `docker compose up -d (with cwd ${dir})`,
    }),
    composeFile: {
      path: 'docker-compose.yml',
      content: () => [
        'services:',
        '  mongodb:',
        '    image: mongo:8',
        '    restart: unless-stopped',
        '    ports:',
        '      - "27017:27017"',
        '    volumes:',
        '      - mongodb_data:/data/db',
        '',
        'volumes:',
        '  mongodb_data:',
        '',
      ].join('\n'),
    },
    marker: { path: 'docker-compose.yml', mustContain: 'image: mongo' },
    installHint: 'Docker Compose pulls the official MongoDB image and creates the named volume on first start; no host MongoDB install is part of this recipe',
  },
  redis: {
    id: 'redis',
    framework: 'Redis via Docker Compose',
    category: 'database',
    toolchains: ['docker'],
    generator: (dir) => ({
      command: 'docker',
      args: ['compose', 'up', '-d'],
      display: `docker compose up -d (with cwd ${dir})`,
    }),
    composeFile: {
      path: 'docker-compose.yml',
      content: () => [
        'services:',
        '  redis:',
        '    image: redis:8',
        '    restart: unless-stopped',
        '    command: redis-server --appendonly yes',
        '    ports:',
        '      - "6379:6379"',
        '    volumes:',
        '      - redis_data:/data',
        '',
        'volumes:',
        '  redis_data:',
        '',
      ].join('\n'),
    },
    marker: { path: 'docker-compose.yml', mustContain: 'image: redis' },
    installHint: 'Docker Compose pulls the official Redis image and creates the named volume on first start; no host Redis install is part of this recipe',
  },
};

/** Technologies users ask for that deliberately have NO recipe (research gap). */
export const UNSUPPORTED_FRAMEWORK_MENTIONS: Array<{ pattern: RegExp; name: string; note: string }> = [
  {
    pattern: /\bkotlin\b|\bandroid (app|application|project)\b/,
    name: 'Kotlin/Android',
    note: 'no verified generator recipe in Daedalus yet (no Gradle/Android SDK preflight) — do not fake a skeleton',
  },
  {
    pattern: /\bsqlite\b/,
    name: 'SQLite',
    note: 'SQLite is an embedded database file, not a server or generated project — nothing is installed or scaffolded; add the SQLite driver to an existing app project instead',
  },
];

type FrameworkAlternative = { pattern: RegExp; pick: (text: string) => ScaffoldRecipeId };

const FRAMEWORK_ALTERNATIVES: FrameworkAlternative[] = [
  { pattern: /\bnext\.?\s?js\b|\bnextjs\b/, pick: () => 'nextjs' },
  { pattern: /\bangular\b/, pick: () => 'angular' },
  { pattern: /\blaravel\b/, pick: () => 'laravel' },
  { pattern: /\bflutter\b/, pick: () => 'flutter' },
  { pattern: /\bsveltekit\b|\bsvelte\s?kit\b|\bsvelte\b/, pick: () => 'sveltekit' },
  { pattern: /\bnuxt(?:\.?js)?\b|\bnuxtjs\b/, pick: () => 'nuxt' },
  { pattern: /\bastro\b/, pick: () => 'astro' },
  { pattern: /\bnest(?:\.?js)?\b|\bnestjs\b/, pick: () => 'nestjs' },
  { pattern: /\bdjango\b/, pick: () => 'django' },
  { pattern: /\bexpo\b|\breact[ -]?native\b|\breactnative\b/, pick: () => 'expo' },
  { pattern: /\bexpress(?:\.?js)?\b|\bexpressjs\b/, pick: () => 'express' },
  // Database stacks come after app/API frameworks so a combined goal such
  // as "Next.js with MySQL" scaffolds the app first; a database-only goal
  // lands here and gets a Compose recipe rather than a project generator.
  { pattern: /\bmysql\b|\bmaria\s?db\b/, pick: () => 'mysql' },
  { pattern: /\bpostgres(?:ql)?\b/, pick: () => 'postgres' },
  { pattern: /\bmongo(?:db)?\b/, pick: () => 'mongodb' },
  { pattern: /\bredis\b/, pick: () => 'redis' },
  // Vite last: "vite + vue" goals also mention vue, and a bare vue goal
  // without vite still maps to the vite-vue recipe (the supported path).
  { pattern: /\bvue\b|\bvite\b/, pick: (text) => (/\bvue\b/.test(text) && !/\breact\b/.test(text) ? 'vite-vue' : 'vite-react') },
];

/**
 * Creation intent: the goal asks to bring a new project/app into being.
 * Deliberately verb-led (Indonesian + English) so questions, explanations,
 * and fixes to existing files never trip scaffold or completion gating.
 */
const SCAFFOLD_INTENT =
  /\b(buat|buatkan|buatin|bikin|bikinin|membuat|create|make|build|generate|scaffold|set[ -]?up|new|baru|initiali[sz]e|init|start|develop)\b/i;

const CREATION_VERB =
  /\b(create|build|make|generate|scaffold|write|set[ -]?up|add|implement|develop|buat|buatkan|buatin|bikin|bikinin|membuat|tulis|tambahkan|tambah)\b/i;

const ARTIFACT_NOUN =
  /\b(project|proyek|app|aplikasi|application|website|web app|site|situs|page|halaman|file|folder|direktori|directory|component|komponen|module|modul|endpoint|api|service|dashboard|landing|form|script|config|konfigurasi)\b/i;

const FIX_INTENT = /\b(fix|repair|debug|perbaiki|betulkan|refactor|rename|upgrade|downgrade|tweak|adjust|migrate)\b/i;

const QUESTION_START = /^\s*(what|how|why|when|where|which|who|explain|describe|tell me|show me|apa|apakah|bagaimana|kenapa|mengapa|jelaskan|ceritakan|gimana)\b/i;

const TARGET_STOPWORDS = new Set(['itu', 'ini', 'tersebut', 'the', 'a', 'an', 'sana', 'sini', 'that', 'this', 'baru', 'new', 'create', 'build', 'make', 'folder', 'directory']);

export type ScaffoldMatch = {
  recipe: ScaffoldRecipe;
  /** Relative target dir inside the workspace (sanitized). */
  targetDir: string;
};

/** Flutter project names are snake_case; derive from the target dir name. */
export function flutterProjectName(targetDir: string): string {
  const name = basename(targetDir)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'app_$1');
  return name.length > 0 ? name : 'app';
}

/** Django project names use the same snake_case identifier rule as Flutter. */
export function djangoProjectName(targetDir: string): string {
  return flutterProjectName(targetDir);
}

/** Extract an explicit folder target ("di folder X", "in the X folder", "folder X"), sanitized. */
export function extractTargetDir(text: string): string {
  return explicitTargetFolder(text) ?? 'app';
}

/**
 * The folder a text explicitly names as its destination, sanitized — or
 * undefined when the text names none. Unlike extractTargetDir there is
 * no 'app' fallback: callers that must not guess (the task-target
 * anchor below) need "no folder named" to stay distinguishable from a
 * folder that was named.
 */
export function explicitTargetFolder(text: string): string | undefined {
  const patterns = [
    /\b(?:di|in|into|ke|at)\s+(?:the\s+)?(?:folder|direktori|directory|dir)\s*[:\-]?\s*([A-Za-z0-9_][A-Za-z0-9_./-]*)/i,
    /\b(?:in|into|at)\s+(?:the\s+)?([A-Za-z0-9_][A-Za-z0-9_./-]*)\s+(?:folder|directory|dir)\b/i,
    /\b(?:folder|direktori|directory|dir)\s+(?:bernama\s+|named\s+|called\s+)?([A-Za-z0-9_][A-Za-z0-9_./-]*)/i,
    /\b(?:named|called|bernama)\s+["'`]?([A-Za-z0-9_][A-Za-z0-9_./-]*)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = match?.[1]?.replace(/[.,;:!?]+$/, '');
    if (!candidate) continue;
    if (TARGET_STOPWORDS.has(candidate.toLowerCase())) continue;
    if (candidate.startsWith('/') || candidate.startsWith('~')) continue;
    const segments = candidate.split('/').filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
    if (segments.length === 0) continue;
    return segments.join('/');
  }
  return undefined;
}

/** Does the goal ask to create a NEW project of a recipe-backed framework? */
export function detectScaffoldRequest(text: string): ScaffoldMatch | undefined {
  if (QUESTION_START.test(text.trim())) return undefined;
  if (!SCAFFOLD_INTENT.test(text)) return undefined;
  const lower = text.toLowerCase();
  for (const alternative of FRAMEWORK_ALTERNATIVES) {
    if (alternative.pattern.test(lower)) {
      return { recipe: SCAFFOLD_RECIPES[alternative.pick(lower)], targetDir: extractTargetDir(text) };
    }
  }
  return undefined;
}

/** Named-but-unsupported framework mentions under a creation intent. */
export function detectUnsupportedFramework(text: string): { name: string; note: string } | undefined {
  if (QUESTION_START.test(text.trim())) return undefined;
  if (!SCAFFOLD_INTENT.test(text)) return undefined;
  const lower = text.toLowerCase();
  for (const entry of UNSUPPORTED_FRAMEWORK_MENTIONS) {
    if (entry.pattern.test(lower)) return { name: entry.name, note: entry.note };
  }
  return undefined;
}

export type CreationGoal = {
  creation: boolean;
  scaffold?: ScaffoldMatch;
  unsupported?: { name: string; note: string };
};

/**
 * Conservative creation-goal classification shared by the scaffold
 * playbook and the completion gate. Questions/explanations (leading
 * question word or trailing "?") and fix-shaped goals without a creation
 * verb never classify as creation; existing-repo bug/feature/refactor
 * flows that actually change files are unaffected either way (the gate
 * only refuses when nothing was created).
 */
export function detectCreationGoal(goal: string, doneCriteria: string[] = []): CreationGoal {
  if (goal.trim().endsWith('?') || QUESTION_START.test(goal)) return { creation: false };
  const scaffold = detectScaffoldRequest([goal, ...doneCriteria].join('\n'));
  if (scaffold) return { creation: true, scaffold };
  const unsupported = detectUnsupportedFramework(goal);
  const text = goal.toLowerCase();
  if (unsupported) return { creation: true, unsupported };
  if (!CREATION_VERB.test(text)) return { creation: false };
  if (FIX_INTENT.test(text) && !/\b(create|scaffold|buat|buatkan|bikin|membuat|generate)\b/i.test(text)) {
    return { creation: false };
  }
  if (!ARTIFACT_NOUN.test(text)) return { creation: false };
  return { creation: true };
}

/**
 * Bring-into-being verbs: the goal wishes a NEW artifact into existence
 * ("buat project…", "create a page…"), as opposed to the add/improve
 * verbs in CREATION_VERB ("tambahkan pemilih tanggal di halaman") that
 * operate on an existing artifact. The clarification gate below only
 * owes a requirements round to the first kind: a tiny edit to existing
 * work never has to interrogate the user first.
 */
const BRING_INTO_BEING =
  /\b(buat|buatkan|buatin|bikin|bikinin|membuat|create|make|build|generate|scaffold|new|baru)\b/i;

/**
 * How much of the build brief the goal itself already names, over the
 * three cheap deterministic signals available without a model call:
 * an explicit target folder, a chosen stack/framework (a scaffold
 * recipe match), and concrete done-criteria. This is the
 * "underspecified" test the pre-build question gate hangs on: a raw
 * one-line prompt naming only a stack ("buat project vite tentang
 * kehadiran mahasiswa") scores 1 and gets asked; a brief that already
 * pins a folder AND a stack — or stack + criteria — is specified
 * enough to build from directly.
 */
export type CreationSpecificity = { folder: boolean; stack: boolean; criteria: boolean; named: number };

export function creationSpecificity(goal: string, doneCriteria: string[] = []): CreationSpecificity {
  const joined = [goal, ...doneCriteria].join('\n');
  const folder = explicitTargetFolder(joined) !== undefined;
  const stack = detectScaffoldRequest(joined) !== undefined || detectUnsupportedFramework(goal) !== undefined;
  const criteria = doneCriteria.some((criterion) => criterion.trim().length > 0);
  return { folder, stack, criteria, named: Number(folder) + Number(stack) + Number(criteria) };
}

/**
 * Would this goal owe the user one clarifying question round before
 * anything in the workspace changes? The gate's full rule (the agent
 * loop adds the run-shape conditions: Auto/Manual mode, top-level task,
 * not an execute-the-plan follow-up, gate enabled):
 *
 * - creation-shaped per detectCreationGoal (questions and fix-shaped
 *   goals never classify, so they never gate);
 * - bring-into-being or scaffold-shaped — edits to existing artifacts
 *   ("tambahkan X di halaman") never gate, however underspecified;
 * - underspecified: fewer than two of {folder, stack, criteria} named.
 *
 * Whether asking was WORTH it is a quality question the harness does
 * not adjudicate — it enforces only that a round happens before the
 * first mutation on a raw creation brief.
 */
export function questionGateAppliesToGoal(goal: string, doneCriteria: string[] = []): boolean {
  const creation = detectCreationGoal(goal, doneCriteria);
  if (!creation.creation) return false;
  if (!creation.scaffold && !BRING_INTO_BEING.test(goal)) return false;
  return creationSpecificity(goal, doneCriteria).named < 2;
}

export type ToolchainProbe = { tool: string; ok: boolean; version?: string };

export type ToolchainProbeFn = (tool: string) => Promise<ToolchainProbe>;

/** Probe every binary once; never throws (a probe failure reads as MISSING). */
export async function probeToolchains(tools: string[], probe: ToolchainProbeFn): Promise<ToolchainProbe[]> {
  const unique = [...new Set(tools)];
  return Promise.all(
    unique.map(async (tool) => {
      try {
        return await probe(tool);
      } catch {
        return { tool, ok: false };
      }
    }),
  );
}

export function formatToolchainSummary(probes: ToolchainProbe[]): string {
  if (probes.length === 0) return 'not probed';
  return probes.map((probe) => (probe.ok ? `${probe.tool} ${probe.version ?? 'ok'}` : `${probe.tool} MISSING`)).join('; ');
}

/** The recipe's required binaries that the preflight found missing. */
export function missingToolchains(recipe: ScaffoldRecipe, probes: ToolchainProbe[]): string[] {
  const byTool = new Map(probes.map((probe) => [probe.tool, probe]));
  return recipe.toolchains.filter((tool) => byTool.get(tool)?.ok !== true);
}

/**
 * One step of a recipe's declared command chain. The chain is what a
 * single approval covers in ask-first modes (see ExecutionHarness): the
 * generator, the install, and the build/validate command — declared
 * here, from the recipe, so approval matching never guesses at prose.
 */
export type ScaffoldChainStep = {
  step: 'generate' | 'install' | 'build' | 'start' | 'verify';
  /** Short label for approval cards and plan steps ('install'). */
  label: string;
  /** The exact command line the recipe prescribes for this step. */
  display: string;
  /** Leading tokens a run_command call must match to count as this step. */
  tokens: string[];
};

const NPM_INSTALL_TOKENS = ['npm', 'install'];
const NPM_BUILD_TOKENS = ['npm', 'run', 'build'];

/** Declared install argv per recipe; absent = the recipe has no install step. */
const CHAIN_INSTALL_TOKENS: Partial<Record<ScaffoldRecipeId, string[]>> = {
  nextjs: NPM_INSTALL_TOKENS,
  'vite-react': NPM_INSTALL_TOKENS,
  'vite-vue': NPM_INSTALL_TOKENS,
  angular: NPM_INSTALL_TOKENS,
  sveltekit: NPM_INSTALL_TOKENS,
  nuxt: NPM_INSTALL_TOKENS,
  astro: NPM_INSTALL_TOKENS,
  nestjs: NPM_INSTALL_TOKENS,
  expo: NPM_INSTALL_TOKENS,
  laravel: ['composer', 'install'],
  flutter: ['flutter', 'pub', 'get'],
};

/** Declared build/validate argv per recipe; absent = no build step. */
const CHAIN_BUILD_TOKENS: Partial<Record<ScaffoldRecipeId, string[]>> = {
  nextjs: NPM_BUILD_TOKENS,
  'vite-react': NPM_BUILD_TOKENS,
  'vite-vue': NPM_BUILD_TOKENS,
  angular: NPM_BUILD_TOKENS,
  sveltekit: NPM_BUILD_TOKENS,
  nuxt: NPM_BUILD_TOKENS,
  astro: NPM_BUILD_TOKENS,
  nestjs: NPM_BUILD_TOKENS,
  flutter: ['flutter', 'analyze'],
  django: ['python3', 'manage.py', 'check'],
};

/** Split a command line into tokens, stripping one level of quoting. */
export function commandLineTokens(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/^["']|["']$/g, ''));
}

/**
 * The recipe's declared command chain for a target dir: the commands one
 * approval covers for a scaffold task. Database recipes chain their
 * start + verify commands; framework/api recipes chain generator →
 * install → build (each only when the recipe declares it). The
 * container-route generator line counts as the same generate step.
 */
export function scaffoldApprovalChain(match: ScaffoldMatch, host: ScaffoldHostInfo = DEFAULT_SCAFFOLD_HOST): ScaffoldChainStep[] {
  const { recipe, targetDir } = match;
  if (recipe.category === 'database') {
    const start = recipe.generator(targetDir);
    return [
      { step: 'start', label: 'start', display: 'docker compose up -d', tokens: [start.command, ...start.args] },
      { step: 'verify', label: 'verify', display: 'docker compose ps', tokens: ['docker', 'compose', 'ps'] },
    ];
  }
  const generator = recipe.generator(targetDir);
  const steps: ScaffoldChainStep[] = [
    { step: 'generate', label: 'generator', display: generator.display, tokens: generateMatchTokens([generator.command, ...generator.args], targetDir) },
  ];
  if (recipe.container) {
    const dockerLine = renderDockerGeneratorLine(recipe, targetDir, host);
    steps.push({ step: 'generate', label: 'generator', display: dockerLine, tokens: generateMatchTokens(commandLineTokens(dockerLine), targetDir) });
  }
  const install = CHAIN_INSTALL_TOKENS[recipe.id];
  if (install && !recipe.generatorInstallsDependencies) {
    steps.push({ step: 'install', label: 'install', display: install.join(' '), tokens: [...install] });
  }
  const build = CHAIN_BUILD_TOKENS[recipe.id];
  if (build) steps.push({ step: 'build', label: 'build', display: build.join(' '), tokens: [...build] });
  return steps;
}

/**
 * Match tokens for a generator line: everything up to and including the
 * target dir. The recipe's flags after the dir are prescribed verbatim,
 * but a model that varies a trailing flag still ran the declared
 * generator into the declared folder — that is the step. Requiring the
 * full argv would make the chain (and its single approval) evaporate
 * over one omitted flag.
 */
function generateMatchTokens(tokens: string[], targetDir: string): string[] {
  const dirIndex = tokens.indexOf(targetDir);
  return dirIndex >= 0 ? tokens.slice(0, dirIndex + 1) : tokens;
}

/**
 * Which chain step (if any) a command line belongs to. Leading-token
 * match against the declared tokens: `npm install --no-audit` is the
 * install step, `npm run dev` is nothing the recipe declared.
 */
export function scaffoldChainStepFor(chain: ScaffoldChainStep[], commandLine: string): ScaffoldChainStep | undefined {
  const tokens = commandLineTokens(commandLine);
  if (tokens.length === 0) return undefined;
  for (const step of chain) {
    if (step.tokens.length > tokens.length) continue;
    if (step.tokens.every((token, index) => token === tokens[index])) return step;
  }
  return undefined;
}


export const BOOTSTRAP_PROBE_TOOLS = ['docker', 'mise', 'fnm', 'nvm'];

/**
 * Host facts the container route needs rendered into the playbook: the
 * absolute workspace path (mounted at /work) and the user's uid:gid, so
 * container-generated files stay owned by the user, never root.
 */
export type ScaffoldHostInfo = { workspaceRoot: string; uidGid: string };

export const DEFAULT_SCAFFOLD_HOST: ScaffoldHostInfo = { workspaceRoot: '.', uidGid: '1000:1000' };

/**
 * mise package that provides each host binary, user-level. `npm`/`npx`
 * ride along with node. Tools absent here (composer, django-admin,
 * docker) get prose in the version-manager route instead of a package.
 */
export const MISE_PACKAGE_BY_TOOL: Record<string, string> = {
  node: 'node@22',
  npm: 'node@22',
  npx: 'node@22',
  php: 'php@8.3',
  python3: 'python@3.12',
  flutter: 'flutter@stable',
};

function probeIsOk(probes: ToolchainProbe[], tool: string): boolean {
  return probes.some((probe) => probe.tool === tool && probe.ok);
}

/** The docker route: the recipe's generator inside its official image. */
export function renderDockerGeneratorLine(recipe: ScaffoldRecipe, targetDir: string, host: ScaffoldHostInfo): string {
  const container = recipe.container;
  if (!container) throw new Error(`recipe ${recipe.id} has no container route`);
  const generator = container.generator ? container.generator(targetDir) : recipe.generator(targetDir);
  return `docker run --rm --user ${host.uidGid} -e HOME=/tmp -v ${host.workspaceRoot}:/work -w /work ${container.image} ${generator.display}`;
}

/**
 * The acquisition section rendered when a recipe toolchain is missing:
 * sanctioned ways to get the toolchain, in priority order — the official
 * container image (Docker), then a user-level version manager — or the
 * honest STOP when neither exists. It never names a system package
 * manager or admin rights: user-level only, by contract.
 */
export function renderToolchainAcquisition(
  recipe: ScaffoldRecipe,
  targetDir: string,
  missing: string[],
  probes: ToolchainProbe[],
  host: ScaffoldHostInfo,
): string[] {
  const lines = [
    `- ${recipe.framework} toolchain missing on this host: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} MISSING, so the host generator cannot run as-is. Acquire the toolchain one of these sanctioned ways instead of stopping:`,
  ];
  const dockerOk = probeIsOk(probes, 'docker');
  const miseOk = probeIsOk(probes, 'mise');
  const fnmOk = probeIsOk(probes, 'fnm');
  const nvmOk = probeIsOk(probes, 'nvm');
  let anyRoute = false;
  if (dockerOk && recipe.container) {
    anyRoute = true;
    lines.push(
      `  1. CONTAINER ROUTE (preferred — Docker is available): run the SAME generator in the official ${recipe.container.image} image with the workspace mounted at /work; --user keeps the generated files owned by you, not root:`,
      `     ${renderDockerGeneratorLine(recipe, targetDir, host)}`,
      `     Run it via run_command with timeout_ms 600000 — the first pull downloads the image and is slow (or start it with background: true and poll command_status between other work). The generated files land in the workspace exactly as a host run, so the ${recipe.marker.path} scaffold-marker check under ${targetDir}/ is unchanged. If dependencies still need installing and the host toolchain is still missing, run the install in the container the same way (same image, install command in place of the generator).`,
    );
  }
  if (miseOk || fnmOk || nvmOk) {
    anyRoute = true;
    const managers = [miseOk ? 'mise' : undefined, fnmOk ? 'fnm' : undefined, nvmOk ? 'nvm' : undefined].filter((name): name is string => typeof name === 'string');
    lines.push(`  ${dockerOk && recipe.container ? '2' : '1'}. VERSION-MANAGER ROUTE (${managers.join('/')} available): install the toolchain user-level, then run the host generator exactly as written above:`);
    if (miseOk) {
      const packages = [...new Set(missing.map((tool) => MISE_PACKAGE_BY_TOOL[tool]).filter((pkg): pkg is string => typeof pkg === 'string'))];
      for (const pkg of packages) lines.push(`     mise use --global ${pkg}`);
      if (missing.includes('composer')) lines.push('     then Composer itself from its official installer into ~/.local/bin (user-level; it runs on the PHP you just installed)');
      if (missing.includes('django-admin')) lines.push('     python3 -m pip install --user django  (provides django-admin on the Python you just installed)');
      if (missing.includes('docker')) lines.push('     (Docker itself has no user-level version-manager install)');
    } else if (missing.some((tool) => tool === 'node' || tool === 'npm' || tool === 'npx')) {
      // fnm/nvm only manage node; that is the node-family route.
      if (fnmOk) lines.push('     fnm install 22', '     fnm default 22');
      if (nvmOk) lines.push('     nvm install 22  (from a shell where nvm is loaded)');
    }
    lines.push('     After installing, verify with `<tool> --version` before running the generator; if the install failed, report it plainly instead of improvising.');
  }
  if (!anyRoute) {
    lines.push(
      `- STOP: neither Docker nor a user-level version manager (mise/fnm/nvm) is available on this machine, so there is no sanctioned way to acquire ${missing.join(', ')} from here. Tell the user plainly what to install — Docker, or mise for user-level toolchains — and stop.`,
    );
  }
  lines.push(
    `- Never install a toolchain any other way (no system package manager, no admin rights), and never hand-write a fake ${recipe.framework} skeleton (a hand-made package.json/config pretending to be a generated project) while acquiring one.`,
  );
  return lines;
}

export function renderScaffoldPlaybook(match: ScaffoldMatch, probes: ToolchainProbe[], host: ScaffoldHostInfo = DEFAULT_SCAFFOLD_HOST): string {
  const { recipe, targetDir } = match;
  if (recipe.category === 'database') return renderDatabasePlaybook(match, probes);
  const generator = recipe.generator(targetDir);
  const missing = missingToolchains(recipe, probes);
  const chain = scaffoldApprovalChain(match, host);
  const installStep = chain.find((step) => step.step === 'install');
  const buildStep = chain.find((step) => step.step === 'build');
  const lines = [
    `This task creates a NEW ${recipe.framework} project in \`${targetDir}/\`. Do NOT hand-write the framework skeleton and do NOT spend turns exploring the workspace first — run the official generator exactly once, in the foreground, then build the requested content into the generated structure.`,
    '',
    `Generator (run once via run_command with timeout_ms 600000 — scaffolding is slow and its output streams back as it runs):`,
    `  ${generator.display}`,
    '',
    `- Non-interactive only: the flags above answer every prompt (CI=true semantics; npx runs with -y). If the generator still asks a question, stop and report it instead of waiting for input that will never come.`,
    `- The generator only writes into a folder that does not exist yet or is COMPLETELY EMPTY: do not create_dir and do not write any file inside \`${targetDir}/\` before the generator has succeeded — create-vite and its peers cancel ("Operation cancelled") on a non-empty folder, which leaves no project behind at all.`,
    `- If the generator fails, read the tail of its output before doing anything else — it names the cause. Sanctioned recovery for a not-empty cancellation: when every file inside \`${targetDir}/\` is one you created during THIS task, delete those files and run the generator once more; when the folder holds anything you did not create, stop and quote the generator's error line in your report. Never hand-write a skeleton to fake the marker.`,
    ...(recipe.generatorInstallsDependencies
      ? [
          `- Installing is not a separate step for this recipe: ${recipe.installHint.replace('${dir}', targetDir)}.`,
        ]
      : [
          `- Scaffolding and installing are separate steps: the generator skips installation on purpose. After it finishes, run the install as its own command (timeout_ms 600000): ${recipe.installHint.replace('${dir}', targetDir)}. If the install is the slow part, you may instead start it with background: true and poll command_status between other work — never poll in a tight loop, and never claim the project finished installing before the job reports it exited.`,
        ]),
    `- STEP LOCK — after the generator succeeds, run exactly this sequence in order: (1) ${installStep ? `install dependencies: ${installStep.display} (inside ${targetDir}/, timeout_ms 600000)` : 'dependencies — already installed by the generator'}; (2) write the requested content/pages into the generated structure; (3) verify by building: ${buildStep ? `${buildStep.display} (inside ${targetDir}/)` : 'this recipe declares no build command, so verify the files you wrote exist and say so'}. Never start step (3) before step (1) has actually finished.`,
    `- NEVER run a dev server as an agent step — no npm run dev, next dev, vite dev, ng serve, php artisan serve, flutter run, or python manage.py runserver: a dev server never exits and verifies nothing a build does not. Previewing belongs to the user's own terminal session; if a long-running preview is ever explicitly requested, run it with background: true under the background-job rules — never as the verification step.`,
    `- Approval chain (ask-first modes): the generator, install, and build commands above are covered by ONE approval for this task — approving any of them covers the rest of the chain. If the user DECLINES a required chain step instead (a real decline, not a wait for an answer), do not retry that command unchanged and do not substitute a different command (no dev-server detour): call ask_user to ask how to proceed, or finish with a plain partial report naming the declined step and what remains undone.`,
    `- If \`${targetDir}/AGENTS.md\` or other generated docs exist, read them before writing code.`,
    `- Then build the requested content INTO the generated structure (the pages/components/routes the generator created) — never as a parallel hand-made skeleton beside it.`,
    `- Toolchains on this machine: ${formatToolchainSummary(probes)}.`,
  ];
  if (missing.length > 0) {
    lines.push(...renderToolchainAcquisition(recipe, targetDir, missing, probes, host));
  }
  return lines.join('\n');
}

export function renderDatabasePlaybook(match: ScaffoldMatch, probes: ToolchainProbe[]): string {
  const { recipe, targetDir } = match;
  const compose = recipe.composeFile ?? { path: recipe.marker.path, content: () => '' };
  const generator = recipe.generator(targetDir);
  const missing = missingToolchains(recipe, probes);
  if (missing.length > 0) {
    return [
      `This task asks for ${recipe.framework} in \`${targetDir}/\`, but the required Docker toolchain is not available on this machine.`,
      `- Toolchains on this machine: ${formatToolchainSummary(probes)}.`,
      `- STOP BEFORE WRITING OR STARTING THE STACK: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} MISSING on this machine, so Docker Compose cannot run. Tell the user plainly that Docker with Compose is required and stop — never invent SQL files, a fake database directory, or a claim that ${recipe.framework} is running.`,
      `- Docker is the one toolchain with no user-level bootstrap route (a container route needs Docker itself, and version managers do not provide it): the user installs Docker with Compose themselves — do not try to install it for them, and never reach for a system package manager or admin rights to do so.`,
    ].join('\n');
  }
  const lines = [
    `This task sets up ${recipe.framework} in \`${targetDir}/\`. This is a database stack, not an application skeleton: write the official-image Docker Compose file below into the target directory, then start that stack with Docker Compose. Do NOT scatter SQL files or pretend a database exists outside this Compose stack.`,
    '',
    `1. Write this exact stack with write_file to \`${targetDir}/${compose.path}\` (adjust database names or credentials only when the user specified them):`,
    '```yaml',
    compose.content(targetDir).trimEnd(),
    '```',
    `2. Start it via run_command with cwd \`${targetDir}\` and timeout_ms 600000 (the first image pull can be slow; output streams back as it runs):`,
    `  ${generator.display}`,
    `3. Check the result with \`docker compose ps\` in \`${targetDir}/\`, and report the service port plus the fact that the development passwords in the file must be changed before real use.`,
    `- Approval chain (ask-first modes): starting the stack and checking it (docker compose ps) are covered by ONE approval for this task. If the user DECLINES starting the stack (a real decline, not a wait), do not retry it unchanged and do not substitute a different command: call ask_user, or finish with a plain partial report naming the declined step.`,
    `- ${recipe.installHint}.`,
    `- Toolchains on this machine: ${formatToolchainSummary(probes)}.`,
    '- If the Docker command fails because the daemon is unavailable, report that error plainly and do not claim the database is running.',
  ];
  return lines.join('\n');
}

export function renderUnsupportedPlaybook(unsupported: { name: string; note: string }): string {
  return [
    `This task asks for ${unsupported.name}. Daedalus has no verified generator recipe for it yet — ${unsupported.note}.`,
    `- Do NOT hand-write a skeleton pretending to be a generated ${unsupported.name} project.`,
    `- Look it up before you build. Daedalus has no search engine, so: FIRST call fetch_url on the official ${unsupported.name} install/docs page (you supply the exact URL from your knowledge — e.g. the framework's "getting started"/installation page), and/or probe the official generator with run_command (\`<generator> --help\`). THEN scaffold following what the docs actually say (exact command, flags, and project layout).`,
    `- Fallback order matters: if fetch_url fails or the page doesn't cover installation, rely on \`<generator> --help\` output. NEVER invent install steps from memory and present them as verified — if neither source answers, say so plainly.`,
    `- If part of the request maps to a supported recipe (Next.js, Vite, Angular, Laravel, Flutter, SvelteKit, Nuxt, Astro, NestJS, Django, Expo, Express, or a MySQL/PostgreSQL/MongoDB/Redis Compose stack), scaffold that part with its recipe and say plainly what remains unsupported.`,
    `- Otherwise tell the user plainly what is missing and ask how to proceed instead of improvising a fake project.`,
  ].join('\n');
}

/**
 * Cheap on-disk marker check at completion: the recipe's marker file must
 * exist under the target dir (and carry its narrowing content, when set).
 */
export function scaffoldMarkerPresent(workspaceRoot: string, match: ScaffoldMatch): boolean {
  try {
    const markerPath = join(workspaceRoot, match.targetDir, match.recipe.marker.path);
    if (!existsSync(markerPath)) return false;
    const mustContain = match.recipe.marker.mustContain;
    if (!mustContain) return true;
    const content = readFileSync(markerPath, 'utf8');
    if (match.recipe.id === 'nextjs') {
      try {
        const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
      } catch {
        return false;
      }
    }
    return content.toLowerCase().includes(mustContain.toLowerCase());
  } catch {
    return false;
  }
}

export type CreationCompletionEvidence = {
  /** Files written/edited/created via file tools (children included at the runtime layer). */
  filesChanged: number;
  /** Successful run_command executions (shell-created files are not diffed individually). */
  commandsSucceeded: number;
  /** True when this task delegated to subagents (their ledgers count via the runtime layer). */
  delegated: boolean;
  /** One-line summary of the most recent failed run_command, when any. */
  lastCommandFailure?: string;
};

/**
 * One-line "command — error tail" summary for failure evidence. Bounded:
 * the last two non-empty output lines, capped, so a report names the
 * cause (a cancelled generator, an engine warning) without quoting a log.
 */
export function summarizeCommandFailure(command: string, output: string): string {
  const tail = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ')
    .slice(0, 240);
  return tail ? `\`${command}\` — ${tail}` : `\`${command}\` failed with no output`;
}

export type CreationRefusal = { reason: string; detail: string } | undefined;

/**
 * The completion gate decision, shared by the agent loop (per-task
 * ledger) and the runtime (lineage ledger incl. children). Returns a
 * refusal only for creation-shaped goals with zero creation evidence;
 * non-creation goals and read-only-by-design tasks are untouched. The
 * loop layer defers when the task delegated (children's ledgers are
 * invisible to it; the runtime layer, which sees their file events,
 * decides with `deferWhenDelegated: false`).
 */
export function creationCompletionRefusal(
  goal: CreationGoal,
  evidence: CreationCompletionEvidence,
  markerPresent: boolean,
  options: { deferWhenDelegated?: boolean } = {},
): CreationRefusal {
  if (!goal.creation) return undefined;
  if (options.deferWhenDelegated === true && evidence.delegated) return undefined;
  if (goal.scaffold) {
    // Additionally (not alternatively): scaffold goals need the recipe
    // marker on disk. A hand-written package.json stub elsewhere in the
    // ledger does not substitute for the generated project.
    if (markerPresent) return undefined;
    return {
      reason: 'no_files_created',
      detail: `the scaffold marker ${goal.scaffold.recipe.marker.path} was not found under ${goal.scaffold.targetDir}/, so no ${goal.scaffold.recipe.framework} project exists on disk${evidence.lastCommandFailure ? `; the last failed command shows why: ${evidence.lastCommandFailure}` : ''}`,
    };
  }
  if (evidence.filesChanged > 0) return undefined;
  if (evidence.commandsSucceeded > 0) return undefined;
  return {
    reason: 'no_files_created',
    detail: `no files were created or changed (no write/edit/create and no successful command produced anything)${evidence.lastCommandFailure ? `; the last failed command shows why: ${evidence.lastCommandFailure}` : ''}`,
  };
}

/**
 * ── Task target anchor ───────────────────────────────────────────────
 *
 * The incident this answers (Farid's live PR #22 test, 2026-10-07): a
 * prompt created a Vite project in `tesvite/`, and the follow-up prompt
 * — after the loop breaker correctly stopped its read loop — wrote the
 * requested page into the UNRELATED existing file `ayid/index.html`
 * (overwriting a landing page) and still reported TASK SUCCESS, because
 * validation saw "changes outside the project's packages" and skipped,
 * and the completion gate only counted that *something* changed. The
 * declared target `tesvite/` was never written.
 *
 * The fix gives a creation task a declared target directory and holds
 * the task to it: writes outside the target are blocked in the agent
 * loop, the completion gate demands at least one change INSIDE it, and
 * validation runs the target's own package.json scripts. The anchor is
 * derived conservatively — creation-shaped goals only, and only when
 * the target is actually declared:
 *   (a) a scaffold recipe matched → the recipe's output directory; or
 *   (b) the goal / done criteria / constraints / plan steps explicitly
 *       name a project folder ("di folder X", "in the X folder", …)
 *       AND that folder already exists on disk or the task has already
 *       written into it (i.e. the task itself created it).
 * Anything else stays unanchored and keeps the pre-anchor semantics
 * exactly (changeset-scoped validation, PR #21 completion gate): when
 * in doubt, no anchor — never guess a target the user did not declare.
 */
export type TaskTargetInput = {
  goal: string;
  doneCriteria?: string[];
  constraints?: string[];
  /**
   * The approved plan's OWN texts (step intents + pinned document bodies),
   * set only for plan-execution follow-ups. A folder named here outranks
   * goal/session constraint text, and qualifies even before it exists on
   * disk: the approved plan is the declaration, creating the folder is the
   * task. Without this, a follow-up inherits whatever folder an earlier
   * task in the same chat happened to name (chat-context bleed).
   */
  planSources?: string[];
  /** Plan step intents, weakest source (execution narration, not user text). */
  planSteps?: string[];
  workspaceRoot: string;
  /** Paths the task has changed so far (workspace-relative or absolute inside it). */
  changedPaths?: string[];
};

/**
 * Normalize a path to workspace-relative POSIX form (the change-ledger
 * dialect); undefined when it escapes the workspace root. Absolute
 * paths inside the root resolve against it.
 */
export function workspaceRelativePath(workspaceRoot: string, file: string): string | undefined {
  let rel = isAbsolute(file) ? relative(workspaceRoot, file) : file;
  rel = rel.split(sep).join('/');
  if (rel === '..' || rel.startsWith('../')) return undefined;
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * The top-level folder a plan document's file references point at
 * ("Files: ayid/index.html" → "ayid"), or undefined when the text names no
 * file path. Plan documents declare work through file lists more often
 * than through "folder X" phrasing, so this reads the first path-like
 * token's first segment; `.daedalus` bookkeeping paths never qualify.
 */
export function planDocumentFolder(text: string): string | undefined {
  for (const match of text.matchAll(/(?:^|[\s(`"'>|=:-])([A-Za-z0-9_-]+)\/([A-Za-z0-9_./-]+)/g)) {
    const segment = match[1];
    const rest = match[2] ?? '';
    if (!segment || segment === 'daedalus') continue;
    if (!rest.includes('.') && !rest.includes('/')) continue;
    return segment;
  }
  return undefined;
}

/** True when a workspace-relative path is the target dir or lives beneath it. */
export function pathInsideTarget(rel: string, targetDir: string): boolean {
  return rel === targetDir || rel.startsWith(`${targetDir}/`);
}

function isDirectoryInside(workspaceRoot: string, rel: string): boolean {
  try {
    return statSync(join(workspaceRoot, rel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The task's declared target directory (workspace-relative, POSIX), or
 * undefined when the task is unanchored. See the section comment for the
 * derivation rules; the changed-paths clause is what lets a folder the
 * task creates mid-run (via create_dir/write_file, whose paths land in
 * the loop's ledger) qualify without ever inventing a folder from thin
 * air — the folder must still be NAMED in the task's own text.
 */
export function deriveTaskTargetDir(input: TaskTargetInput): string | undefined {
  const creation = detectCreationGoal(input.goal, input.doneCriteria ?? []);
  if (!creation.creation) return undefined;
  if (creation.scaffold) return creation.scaffold.targetDir;
  // Plan-execution follow-ups anchor to the PLAN's own declaration first:
  // its step intents and document bodies (architecture file lists) name the
  // folder the user approved, ahead of any folder leftover chat-session
  // constraints happen to mention, and the name qualifies on the plan's
  // authority alone — the folder need not exist yet, creating it is the
  // approved work. Other tasks keep the conservative rule below (named
  // folder must already exist or be one this task already changed).
  for (const source of input.planSources ?? []) {
    const candidate = explicitTargetFolder(source) ?? planDocumentFolder(source);
    if (candidate && !candidate.startsWith('.daedalus')) return candidate;
  }
  const changed = (input.changedPaths ?? [])
    .map((path) => workspaceRelativePath(input.workspaceRoot, path))
    .filter((rel): rel is string => rel !== undefined);
  const sources = [input.goal, ...(input.doneCriteria ?? []), ...(input.constraints ?? []), ...(input.planSteps ?? [])];
  for (const source of sources) {
    const candidate = explicitTargetFolder(source);
    if (!candidate) continue;
    if (isDirectoryInside(input.workspaceRoot, candidate)) return candidate;
    if (changed.some((rel) => rel === candidate || rel.startsWith(`${candidate}/`))) return candidate;
  }
  return undefined;
}
