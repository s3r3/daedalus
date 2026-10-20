/**
 * Chat paths for interactive surfaces (CLI chat now, Web composer later).
 *
 * A chat box is not a task queue: a greeting must not spin up the planner,
 * a plan, and a tool loop — and neither must a plain question. Modeled on
 * how the reference agents behave (Crush/Cline): a user message is answered
 * by the model directly, tools appear only when the model actually needs
 * them, and no harness manufactures a generic plan for a question.
 *
 * `classifyChatIntent` deterministically sorts a submitted line into:
 *  - `conversational` — greetings, thanks, smalltalk, identity chit-chat;
 *  - `question` — information-seeking with no request to change, create, or
 *    run anything ("repo ini tentang apa?", "kenapa build gagal?");
 *  - `task` — real work: an imperative to fix/create/run/change something.
 *
 * Conversational lines get `answerConversational` and questions get
 * `answerQuestion`; both are a single tool-less provider call — no
 * TaskRunner, no plan, no validation, no task events. The classifier is
 * deterministic and bias-to-task on ambiguity, so it is fully unit-testable
 * without an LLM.
 *
 * A subset of questions — read-only questions ABOUT workspace content
 * ("lihat isi folder src", "isi file README apa", "di mana file config.ts")
 * — takes the grounded Q&A path: `isWorkspaceContentQuestion` routes them
 * to `question` (never a task), and `answerWorkspaceQuestion` answers the
 * single-shape ones (list a folder, read a file, locate a file) directly
 * from the filesystem with ZERO model calls. Anything needing synthesis
 * falls back to the single model call in `answerQuestion` — still no task.
 * The grounded path is read-only by construction: only
 * readdir/stat/readFile, never writes or execution.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { LLMProvider, Message } from '../providers/llm/types.ts';

export type ChatIntent = 'conversational' | 'question' | 'task';

/** Persona for the tool-less conversational reply. */
export const CONVERSATIONAL_SYSTEM_PROMPT = [
  'You are Daedalus, an agentic coding assistant living in the user\'s terminal and web IDE.',
  'The user is making casual conversation, not asking for coding work (yet).',
  'Reply briefly and warmly, in the user\'s language and mix (Indonesian if they write',
  'Indonesian, English if English). Do not create plans, do not mention tools, and do',
  'not claim to have modified anything. If it fits naturally, end by inviting them to',
  'describe any coding task they have in mind.',
].join(' ');

/** Persona for the fast Q&A path: answer the question, never plan or execute. */
export const QUESTION_SYSTEM_PROMPT = [
  'You are Daedalus, an agentic coding assistant living in the user\'s terminal and web IDE.',
  'The user is asking a question, not requesting coding work.',
  'Answer directly and concisely, in the user\'s language (Indonesian if they write',
  'Indonesian, English if English). Use the workspace context supplied with the',
  'question when it helps, and say plainly what you do not know instead of guessing.',
  'Never make a plan, never list implementation steps, never claim to have changed,',
  'created, or run anything, and do not offer to start a task unless asked.',
].join(' ');

/** Casual lines stay short; anything longer is treated as work. */
const MAX_CONVERSATIONAL_CHARS = 90;
const MAX_CONVERSATIONAL_WORDS = 12;

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.!…,\s]+/, '')
    .replace(/[.!…]+$/, '')
    .trim();
}

/**
 * Imperative change/create/run verbs (Indonesian + English). Any of these
 * vetoes the question path: "hai tolong fix bug ini" is work even though it
 * starts with a greeting. Explanation verbs (jelaskan/explain/describe) are
 * deliberately NOT here — explaining is a question, not a change.
 * `build`/`test`/`lint` are also excluded: they double as question subjects
 * ("kenapa build gagal?"), so they only count as task signals outside an
 * interrogative frame.
 */
const IMPERATIVE_VERB_PATTERN =
  /\b(fix|repair|debug|refactor|implement|create|generate|compile|deploy|install|uninstall|run|execute|add|remove|delete|update|upgrade|edit|change|modify|write|rewrite|rename|move|copy|migrate|optimize|review|audit|perbaiki|benerin|buatkan|bikin(kan)?|tambah(kan)?|hapus(kan)?|ubah(i)?|ganti|jalankan|tulis(kan)?|sunting|pindah(kan)?|salin|buang|pasang|lepas|kerjakan|kerjain|selesaikan|cekkan|periksakan|lihat|tampilkan|buka|show|list)\b/;

/** Verbs that mean work outside a question frame but may be a question's subject. */
const AMBIGUOUS_WORK_VERB_PATTERN = /\b(build|test|lint)\b/;

/** File names, extensions, paths, code fences: concrete work artifacts. */
const FILE_REF_PATTERN =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|json|ya?ml|toml|ini|md|txt|css|scss|less|html?|xml|sql|lock|env)\b/;
const PATH_PATTERN = /(^|\s)[\w@.-]+(\/[\w.@-]+)+\/?(\s|$)/;
const CODE_FENCE_PATTERN = /```/;

/** "file ini", "repo itu" — pointing at the codebase itself. */
const CODEBASE_THING_PATTERN = /\b(file|kode|folder|repo|proyek|project|error|fungsi|script) (ini|itu|tersebut)\b/;

function hasHardSignal(text: string): boolean {
  return FILE_REF_PATTERN.test(text)
    || PATH_PATTERN.test(text)
    || CODE_FENCE_PATTERN.test(text)
    || IMPERATIVE_VERB_PATTERN.test(text);
}

function hasTaskSignal(text: string): boolean {
  return hasHardSignal(text)
    || AMBIGUOUS_WORK_VERB_PATTERN.test(text)
    || CODEBASE_THING_PATTERN.test(text);
}

/** Interrogative openers (Indonesian + English). */
const QUESTION_START_PATTERN =
  /^(apa|apakah|gimana|bagaimana|kenapa|mengapa|kok|kapan|berapa|siapa|di ?mana|mana|bisakah|bolehkah|why|what|how|who|when|where|which|is|does|do|can|could)\b/;

/** Explanation requests are questions, not work orders. */
const EXPLANATION_PATTERN = /\b(jelaskan|terangkan|explain|describe|ceritakan)\b/;

/** Project/repo overview phrasings ("repo ini tentang apa", "proyek ini buat apa"). */
const OVERVIEW_PATTERN = /\b(tentang apa|buat apa|ini tentang|struktur (repo|proyek|project|folder|kode|aplikasi))\b/;

/** Asking who the USER is — an identity question for the Q&A path. */
const USER_IDENTITY_PATTERN = /\b(aku|saya|gue|gua) (ini )?(siapa|namanya siapa)\b|\bsiapa (aku|saya|gue|gua)\b/;

/** "file ini ngapain?" — what is this thing doing. */
const NGAPAIN_PATTERN = /\bngapain\b/;

function isQuestionText(text: string): boolean {
  return QUESTION_START_PATTERN.test(text)
    || EXPLANATION_PATTERN.test(text)
    || OVERVIEW_PATTERN.test(text)
    || USER_IDENTITY_PATTERN.test(text)
    || NGAPAIN_PATTERN.test(text);
}

/** Pure knowledge questions ("apa itu …?") are chat, not repository work. */
const DEFINITION_QUESTION = /^(apa itu|apa yang dimaksud|what(?:'s| is)(?!\s+in\b)|pengertian|definisi|arti)\b/;

const GREETING_PREFIX =
  /^(ha+i+|ha+lo+|hello+|hi+|hei+|hey+|hola|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam)|assalamu'?alaikum|permisi|woi+|bro|sis|kak|bang|gan|min|daedalus)[\s,!.]*/;

const SMALLTALK_REST =
  /^(apa kabar|gimana kabar(nya|mu)?|kabar(nya|mu)? gimana|lagi apa|lagi ngapain|sedang apa|gimana harimu|how are you|how'?s it going|what'?s up|sup|sehat|baik(-baik)?( saja)?|kabar baik|alhamdulillah baik)$/;

const THANKS_PATTERN =
  /^(terima kasih|makasih|thanks|thank you|thx|tq)(\s+(banyak|ya|loh|kak|bang|daedalus|semuanya))?\s*(🙏|😊)?$/;

const BYE_PATTERN =
  /^(dadah|bye|bye-bye|sampai jumpa|see you|selamat tinggal|gtg|udah dulu ya|duluan ya)\s*(👋)?$/;

const IDENTITY_PATTERN =
  /^(siapa (kamu|namamu|nama kamu)|who are you|kamu (ini )?siapa|namamu siapa|nama kamu siapa|(kamu|kau|anda|you|daedalus) (itu )?(siapa|who)|kamu namanya siapa)$/;

const CAPABILITY_PATTERN =
  /(kamu|kau|anda|you|daedalus).{0,24}(bisa apa|bisa ngapain|bisa bantu apa|what can you do|kemampuan(mu|nya)?|fitur(mu|nya)?)|^(bisa apa|kamu bisa apa|bisa bantu apa)/;

const ACK_PATTERN = /^(ok+|oke+|okey|baik( lah)?|baiklah|siap|sip|mantap|noted|mengerti|paham|siap+|good|nice|cool|great|awesome|lol|wkwk+|haha+|hehe+|siap bos|aman|gas|lanjut|setuju)\s*(👍|🙏|😊|🔥)?$/;

const PING_PATTERN = /^(ping|pong|tes|test|cek|tes tes|halo tes|testing|hadir)\s*(👋)?$/;

const QUESTION_STARTERS = /^(apa|apakah|gimana|bagaimana|kenapa|mengapa|kapan|berapa|bisakah|bolehkah|kok)\b/;

function stripGreetings(text: string): string {
  let rest = text;
  for (let i = 0; i < 3; i += 1) {
    const stripped = rest.replace(GREETING_PREFIX, '').trim();
    if (stripped === rest) break;
    rest = stripped;
  }
  return rest;
}

/** Unambiguous chit-chat: exact smalltalk shapes and greeting-only lines. */
function isClearlyConversational(text: string): boolean {
  if (THANKS_PATTERN.test(text) || BYE_PATTERN.test(text) || IDENTITY_PATTERN.test(text)) return true;
  if (CAPABILITY_PATTERN.test(text)) return true;
  if (ACK_PATTERN.test(text) || PING_PATTERN.test(text)) return true;
  const rest = stripGreetings(text);
  if (rest !== text && rest === '') return true;
  if (SMALLTALK_REST.test(rest)) return true;
  return false;
}

function isConversationalText(text: string): boolean {
  if (isClearlyConversational(text)) return true;

  const rest = stripGreetings(text);
  if (SMALLTALK_REST.test(rest)) return true;

  const words = text.split(' ').filter(Boolean);
  // Short questions addressed to the assistant personally ("kamu suka kopi?").
  if (words.length <= 8 && /\b(kamu|kau|anda|you|daedalus)\b/.test(text)) return true;
  // Short general questions with no work signal ("gimana cara masak nasi?"
  // reaches here only when the Q&A path did not claim it first).
  if (words.length <= MAX_CONVERSATIONAL_WORDS && QUESTION_STARTERS.test(text)) return true;

  return false;
}

/**
 * Verbs that request a change, creation, deletion, or execution. These
 * disqualify the grounded Q&A path even when the line also asks to look at
 * something: "lihat isi folder lalu hapus yang lama" is work, not a
 * question. Read/display verbs (lihat, tampilkan, show, list) are
 * deliberately NOT here — asking to SEE workspace content is a question.
 */
const MUTATING_VERB_PATTERN =
  /\b(fix|repair|debug|refactor|implement|create|generate|compile|deploy|install|uninstall|run|execute|add|remove|delete|update|upgrade|edit|change|modify|write|rewrite|rename|move|copy|migrate|optimize|review|audit|perbaiki|benerin|buatkan|bikin(kan)?|tambah(kan)?|hapus(kan)?|ubah(i)?|ganti|jalankan|tulis(kan)?|sunting|pindah(kan)?|salin|buang|pasang|lepas|kerjakan|kerjain|selesaikan|cekkan|periksakan)\b/;

/** "lihat isi folder X", "show me the files in X", "ada file apa aja di X" — listing requests. */
const WORKSPACE_LIST_PHRASE =
  /\b(lihat|tampilkan|tunjukin|tunjukkan|daftar|show|list)\b.{0,24}\b(isi|daftar|files?|folders?|contents?)\b|\bwhat'?s\s+in\b|\b(ada|terdapat)\b.{0,32}\b(apa|aja|saja)\b.{0,24}\b(di|dalam)\b|\b(file|folder|direktori)\b.{0,16}\b(apa|aja|saja)\b.{0,24}\b(di|dalam)\b|\b(apa|apakah)\b.{0,12}\bisi\b.{0,16}\b(folder|direktori|file|berkas)\b/;

/** "isi file README apa", "show me the content of Z" — read requests. */
const WORKSPACE_READ_PHRASE =
  /\b(isi|konten)\b.{0,16}\b(file|berkas)\b|\bshow\s+me\b.{0,32}\bcontents?\b/;

/** "di mana file X", "where is the config file" — locate requests. */
const WORKSPACE_LOCATE_PHRASE =
  /\bdi ?mana\b.{0,32}\b(file|folder|berkas|direktori)\b|\bwhere(?:'s|\s+is)?\b.{0,32}\b(files?|folders?)\b/;

/**
 * Read-only question about workspace content. True when the line asks to
 * see something in the workspace (list/read/locate) and carries no
 * mutating verb. Ambiguity fails toward `task`: any change/create/delete/
 * run verb disqualifies, so mixed lines never take the direct-answer path.
 */
export function isWorkspaceContentQuestion(input: string): boolean {
  const text = normalize(input);
  if (!text || MUTATING_VERB_PATTERN.test(text)) return false;
  return WORKSPACE_LIST_PHRASE.test(text)
    || WORKSPACE_READ_PHRASE.test(text)
    || WORKSPACE_LOCATE_PHRASE.test(text);
}

export type WorkspaceQAOperation =
  | { kind: 'list'; target: string; lang: 'id' | 'en' }
  | { kind: 'read'; target: string; lang: 'id' | 'en' }
  | { kind: 'locate'; target: string; lang: 'id' | 'en'; wantDir: boolean };

type QATemplate = { pattern: RegExp; target: number; lang: 'id' | 'en'; dirGroup?: number };

/** Read shapes are tried before list shapes: "show me the content of X" is a read, not a listing. */
const QA_READ_TEMPLATES: QATemplate[] = [
  { pattern: /^(?:tolong\s+|coba\s+)?(?:lihat|tampilkan|tunjukin|tunjukkan|baca)\s+(?:isi|konten)\s+(?:file|berkas)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^(?:isi|konten)\s+(?:file|berkas)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^show\s+me\s+(?:the\s+)?contents?\s+of\s+(.+)$/, target: 1, lang: 'en' },
];

const QA_LIST_TEMPLATES: QATemplate[] = [
  { pattern: /^(?:tolong\s+|coba\s+)?(?:lihat|tampilkan|tunjukin|tunjukkan)\s+(?:isi|daftar)\s+(?:folder|direktori|dir)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^(?:ada|terdapat)\s+(?:file|folder|berkas|direktori).{0,24}?\b(?:apa|aja|saja)\b.{0,24}?\b(?:di|dalam)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^(?:file|folder|direktori)\s+(?:apa|aja|saja).{0,24}?\b(?:di|dalam)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^daftar\s+(?:file|folder)\s+(?:di|dalam)\s+(.+)$/, target: 1, lang: 'id' },
  { pattern: /^what'?s\s+in\s+(?:the\s+)?(.+?)\s+(?:folder|directory|dir)$/, target: 1, lang: 'en' },
  { pattern: /^(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:files?|folders?|contents?)\s+(?:in|inside|of)\s+(.+)$/, target: 1, lang: 'en' },
];

const QA_LOCATE_TEMPLATES: QATemplate[] = [
  { pattern: /^di ?mana\s+(file|folder|berkas|direktori)\s+(.+)$/, target: 2, lang: 'id', dirGroup: 1 },
  { pattern: /^where(?:'s|\s+is)\s+(?:the\s+)?(.+?)\s+(file|folder)$/, target: 1, lang: 'en', dirGroup: 2 },
  { pattern: /^where(?:'s|\s+is)\s+(file|folder)\s+(.+)$/, target: 2, lang: 'en', dirGroup: 1 },
];

/** Strip quotes, a leading folder/file noun, and trailing politeness/question words from a raw target. */
function cleanWorkspaceTarget(raw: string): string {
  let t = raw.trim().replace(/^["'`](.*)["'`]$/, '$1').trim();
  t = t.replace(/^(?:folder|direktori|dir|file|berkas)\s+/i, '');
  t = t.replace(/\s+(?:dong|ya|kak|bang|tolong|nih|deh|aja|saja)$/i, '');
  // "isi file README apa": the trailing "apa" is the question word, not the name.
  t = t.replace(/\s+(?:apa|apaan)$/i, '');
  if (/^(ini|itu|tersebut)$/i.test(t)) return '.';
  return t.trim();
}

function matchQATemplates(templates: QATemplate[], core: string, kind: WorkspaceQAOperation['kind']): WorkspaceQAOperation | null {
  for (const { pattern, target, lang, dirGroup } of templates) {
    const m = pattern.exec(core);
    if (!m) continue;
    const rawTarget = (m[target] ?? '').trim();
    const cleaned = cleanWorkspaceTarget(rawTarget);
    if (!cleaned) return null;
    if (kind === 'locate') {
      const dirWord = dirGroup !== undefined ? (m[dirGroup] ?? '') : '';
      const wantDir = /^(folder|direktori)$/i.test(dirWord);
      return { kind, target: cleaned, lang, wantDir };
    }
    return { kind, target: cleaned, lang } as WorkspaceQAOperation;
  }
  return null;
}

/**
 * Parse a whole line as ONE deterministic workspace Q&A request (list a
 * folder, read a file, locate a file). Returns null when the line is not a
 * clean single-shape request — mixed lines, synthesis questions ("apa
 * fungsi file X?"), and anything with a mutating verb all return null so
 * the caller falls back to the model-backed question path (still no task).
 * Greetings ("hai, lihat isi folder src") are tolerated; anything else
 * around the single request disqualifies it.
 *
 * The returned target is normalized to lowercase (the whole line is
 * lowercased before parsing); resolution is case-insensitive, so "readme"
 * still finds "README.md" on a case-sensitive filesystem.
 */
export function parseWorkspaceQARequest(input: string): WorkspaceQAOperation | null {
  const text = normalize(input);
  if (!text || MUTATING_VERB_PATTERN.test(text)) return null;
  const core = stripGreetings(text).replace(/\?+$/, '').trim();
  if (!core) return null;
  return matchQATemplates(QA_READ_TEMPLATES, core, 'read')
    ?? matchQATemplates(QA_LIST_TEMPLATES, core, 'list')
    ?? matchQATemplates(QA_LOCATE_TEMPLATES, core, 'locate');
}

/**
 * Classify one submitted chat line into conversational / question / task.
 * `task` is the safe default for anything ambiguous that carries a work
 * signal; a question needs an interrogative frame and no imperative verb.
 */
export function classifyChatIntent(input: string): ChatIntent {
  const text = normalize(input);
  if (!text) return 'conversational';
  if (text.length > MAX_CONVERSATIONAL_CHARS) return 'task';
  // "Apa itu X?" is a knowledge question for chat unless it also carries a
  // real work signal (verb/file) — only bare nouns may be overridden.
  if (DEFINITION_QUESTION.test(text) && !hasHardSignal(text)) return 'conversational';
  if (isClearlyConversational(text)) return 'conversational';
  // Grounded workspace Q&A: read-only questions about workspace content
  // ("lihat isi folder src") are answered directly — never a task. The
  // predicate itself excludes mutating verbs, so mixed lines like
  // "lihat isi folder lalu hapus yang lama" keep falling through to task.
  if (isWorkspaceContentQuestion(text)) return 'question';
  // Information-seeking with no change/create/run request. File references
  // do NOT veto this ("apa fungsi file config.ts?" is still a question);
  // an imperative verb does ("tolong jelaskan cara fix bug ini" is work).
  if (isQuestionText(text) && !IMPERATIVE_VERB_PATTERN.test(text)) return 'question';
  if (hasTaskSignal(text)) return 'task';
  if (isConversationalText(text)) return 'conversational';
  // Very short lines with no work signal at all ("cek dong", "lanjutkan",
  // "cuaca hari ini gimana") are conversation; the assistant can ask what
  // they mean. Anything longer defaults to the task path.
  if (text.split(' ').filter(Boolean).length <= 6) return 'conversational';
  return 'task';
}

/** Friendly local reply used when no provider/model is connected yet. */
export function conversationalFallbackReply(): string {
  return [
    'Halo! Saya Daedalus, asisten coding kamu. 👋',
    'Saat ini belum ada provider/model yang terhubung, jadi saya belum bisa mengobrol pakai AI — hubungkan dulu lewat /providers dan /models.',
    'Kalau ada pekerjaan coding, langsung saja jelaskan tugasnya di sini.',
  ].join(' ');
}

/** Local reply for a question when no provider/model is connected yet. */
export function questionFallbackReply(): string {
  return [
    'Saya Daedalus — pertanyaanmu belum bisa saya jawab pakai AI karena belum ada provider/model yang terhubung.',
    'Hubungkan dulu lewat /providers dan /models, lalu tanya lagi; saya jawab langsung tanpa membuat task.',
  ].join(' ');
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Answer one conversational line with a single tool-less provider call.
 * `history` holds prior user/assistant turns of this chat session (oldest
 * first); only the last few are sent. Never creates tasks, plans, or
 * events — that is the whole point of this path.
 */
export async function answerConversational(
  provider: LLMProvider,
  input: string,
  history: Message[] = [],
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: CONVERSATIONAL_SYSTEM_PROMPT },
    ...history.slice(-8),
    { role: 'user', content: input },
  ];
  const response = await provider.chat(messages);
  const text = messageText(response.message).trim();
  return text || conversationalFallbackReply();
}

export type AnswerQuestionOptions = {
  /** Workspace the question is about; grounding context is read from here. */
  workspaceDir: string;
  /** Prior chat turns (oldest first); only the last few are sent. */
  history?: Message[];
};

const IGNORED_TREE_ENTRIES = new Set(['node_modules', '.git']);
const README_CANDIDATES = ['README.md', 'Readme.md', 'readme.md', 'README.txt', 'README'];
const MAX_README_LINES = 60;
const MAX_TREE_ENTRIES = 40;

/**
 * Cheap local grounding for a question: a depth-1 directory listing (minus
 * node_modules/.git), the first ~60 lines of a README when present, and the
 * package.json name/description when present. Pure filesystem reads — no
 * model tool loop, no events. Every piece is best-effort: an unreadable
 * workspace just yields thinner context.
 */
export async function gatherWorkspaceContext(workspaceDir: string): Promise<string> {
  const sections: string[] = [];
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => !IGNORED_TREE_ENTRIES.has(entry.name))
      .slice(0, MAX_TREE_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (names.length > 0) {
      sections.push(`Top-level entries in ${workspaceDir}:\n${names.map((name) => `- ${name}`).join('\n')}`);
    }
  } catch {
    // Unreadable workspace: the answer just gets less grounding.
  }
  for (const candidate of README_CANDIDATES) {
    try {
      const raw = await readFile(join(workspaceDir, candidate), 'utf8');
      const excerpt = raw.split(/\r?\n/).slice(0, MAX_README_LINES).join('\n').trim();
      if (excerpt) sections.push(`${candidate} (first ${MAX_README_LINES} lines):\n${excerpt}`);
      break;
    } catch {
      // Try the next candidate name.
    }
  }
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, 'package.json'), 'utf8')) as {
      name?: unknown;
      description?: unknown;
    };
    const bits = [
      typeof pkg.name === 'string' && pkg.name ? `name: ${pkg.name}` : '',
      typeof pkg.description === 'string' && pkg.description ? `description: ${pkg.description}` : '',
    ].filter(Boolean);
    if (bits.length > 0) sections.push(`package.json: ${bits.join(' · ')}`);
  } catch {
    // No (readable) package.json.
  }
  return sections.join('\n\n');
}

const MAX_QA_LIST_ENTRIES = 60;
const MAX_QA_READ_LINES = 40;
const MAX_QA_READ_BYTES = 1024 * 1024;
const MAX_QA_LOCATE_RESULTS = 10;
const MAX_QA_LOCATE_DEPTH = 8;

/**
 * Case-insensitive fallback: walk the workspace segment by segment,
 * matching each path part against real directory entries. Users type
 * lowercase names ("isi file readme") far more often than exact casing.
 * Never leaves the workspace: every step resolves through readdir results.
 */
async function resolveCaseInsensitive(workspaceDir: string, candidate: string): Promise<string | null> {
  const parts = candidate.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.length === 0) return workspaceDir;
  let dir = workspaceDir;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const hit = entries
      .slice()
      .sort()
      .find((entry) => {
        const lower = entry.toLowerCase();
        return lower === part.toLowerCase() || lower.startsWith(`${part.toLowerCase()}.`);
      });
    if (!hit) return null;
    if (i < parts.length - 1 && (IGNORED_TREE_ENTRIES.has(hit) || hit.startsWith('.'))) return null;
    dir = join(dir, hit);
  }
  return dir;
}

/**
 * Resolve a user-supplied target inside the workspace. Returns null when
 * the target does not exist or would escape the workspace (absolute paths
 * and ".." are rejected). Tries the cleaned target first, then the raw
 * quoted-stripped form, then a case-insensitive walk. Targets are matched
 * against the lowercased request text (parse normalizes case), so the
 * case-insensitive step is what finds "README.md" from "readme".
 */
async function resolveWorkspaceTarget(workspaceDir: string, rawTarget: string): Promise<string | null> {
  const fallback = rawTarget.trim().replace(/^["'`](.*)["'`]$/, '$1').trim();
  const candidates = [cleanWorkspaceTarget(rawTarget), fallback].filter((c, i, arr) => c && arr.indexOf(c) === i);
  for (const candidate of candidates) {
    const resolved = resolve(workspaceDir, candidate);
    if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + sep)) continue;
    try {
      await stat(resolved);
      return resolved;
    } catch {
      // Try the next candidate spelling.
    }
    const insensitive = await resolveCaseInsensitive(workspaceDir, candidate);
    if (insensitive) return insensitive;
  }
  return null;
}

async function listWorkspaceDir(workspaceDir: string, rawTarget: string, lang: 'id' | 'en'): Promise<string | null> {
  const resolved = await resolveWorkspaceTarget(workspaceDir, rawTarget);
  if (!resolved) return null;
  try {
    if (!(await stat(resolved)).isDirectory()) return null;
  } catch {
    return null;
  }
  const entries = await readdir(resolved, { withFileTypes: true });
  const names = entries
    .filter((entry) => !IGNORED_TREE_ENTRIES.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  const rel = relative(workspaceDir, resolved);
  const label = rel ? `${rel}/` : './';
  const head = lang === 'id' ? `Isi folder ${label}:` : `Contents of ${label}:`;
  if (names.length === 0) return `${head}\n${lang === 'id' ? '(kosong)' : '(empty)'}`;
  const shown = names.slice(0, MAX_QA_LIST_ENTRIES);
  const tail = names.length > shown.length
    ? `\n${lang === 'id' ? `(+ ${names.length - shown.length} entri lain disembunyikan)` : `(+ ${names.length - shown.length} more entries hidden)`}`
    : '';
  return `${head}\n${shown.map((name) => `- ${name}`).join('\n')}${tail}`;
}

async function readWorkspaceFile(workspaceDir: string, rawTarget: string, lang: 'id' | 'en'): Promise<string | null> {
  const resolved = await resolveWorkspaceTarget(workspaceDir, rawTarget);
  if (!resolved) return null;
  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory() || fileStat.size > MAX_QA_READ_BYTES) return null;
  } catch {
    return null;
  }
  const raw = await readFile(resolved, 'utf8');
  if (raw.includes('\0')) return null; // binary, not for a chat snippet
  const lines = raw.split(/\r?\n/);
  const truncated = lines.length > MAX_QA_READ_LINES;
  const excerpt = lines.slice(0, MAX_QA_READ_LINES).join('\n');
  const rel = relative(workspaceDir, resolved);
  const head = lang === 'id'
    ? `Isi file ${rel}${truncated ? ` (${MAX_QA_READ_LINES} baris pertama dari ${lines.length})` : ''}:`
    : `Contents of ${rel}${truncated ? ` (first ${MAX_QA_READ_LINES} of ${lines.length} lines)` : ''}:`;
  return `${head}\n${excerpt}`;
}

async function locateWorkspaceEntry(
  workspaceDir: string,
  rawTarget: string,
  lang: 'id' | 'en',
  wantDir: boolean,
): Promise<string | null> {
  const needle = cleanWorkspaceTarget(rawTarget).toLowerCase();
  if (!needle || needle === '.') return null;
  const scored: Array<{ path: string; score: number }> = [];
  const visited = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workspaceDir, depth: 0 }];
  while (stack.length > 0 && scored.length < MAX_QA_LOCATE_RESULTS * 3) {
    const frame = stack.pop();
    if (!frame || frame.depth > MAX_QA_LOCATE_DEPTH) continue;
    let real: string;
    try {
      real = await realpath(frame.dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = await readdir(frame.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_TREE_ENTRIES.has(entry.name)) continue;
      const nameLower = entry.name.toLowerCase();
      const isDir = entry.isDirectory();
      const matchesKind = wantDir ? isDir : !isDir;
      if (matchesKind && (nameLower === needle || nameLower.startsWith(`${needle}.`) || nameLower.includes(needle))) {
        const rel = relative(workspaceDir, join(frame.dir, entry.name));
        const score = nameLower === needle ? 0 : nameLower.startsWith(`${needle}.`) ? 1 : 2;
        scored.push({ path: isDir ? `${rel}/` : rel, score });
      }
      if (isDir) stack.push({ dir: join(frame.dir, entry.name), depth: frame.depth + 1 });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1));
  const hits = scored.slice(0, MAX_QA_LOCATE_RESULTS).map((hit) => `- ${hit.path}`);
  const noun = wantDir ? (lang === 'id' ? 'Folder' : 'Folder') : (lang === 'id' ? 'File' : 'File');
  const found = lang === 'id' ? 'ditemukan di:' : 'found:';
  return `${noun} "${rawTarget.trim()}" ${found}\n${hits.join('\n')}`;
}

/**
 * Grounded workspace Q&A — the fast direct-answer path.
 *
 * ROUTING RULE (the contract the router relies on): a deterministic answer
 * is returned — with zero model calls — only when the whole line parses as
 * ONE list/read/locate request (parseWorkspaceQARequest). Anything else
 * returns null and the caller falls back to the single tool-less model
 * call in `answerQuestion`: still no task, no plan, no validation.
 *
 * Read-only by construction: only readdir/stat/realpath/readFile are used.
 * Nothing is written, executed, or mutated — targets are confined to the
 * workspace, and binary/oversized files are declined (null) instead of
 * dumped.
 */
export async function answerWorkspaceQuestion(input: string, workspaceDir: string): Promise<string | null> {
  const op = parseWorkspaceQARequest(input);
  if (!op) return null;
  switch (op.kind) {
    case 'list':
      return listWorkspaceDir(workspaceDir, op.target, op.lang);
    case 'read':
      return readWorkspaceFile(workspaceDir, op.target, op.lang);
    case 'locate':
      return locateWorkspaceEntry(workspaceDir, op.target, op.lang, op.wantDir);
  }
}

/**
 * Answer one question with a single tool-less provider call grounded in
 * locally gathered workspace context. Like the reference agents, the model
 * simply replies: no TaskRunner, no plan, no validation, no task-store
 * writes, no tool calls on offer.
 */
export async function answerQuestion(
  provider: LLMProvider,
  input: string,
  options: AnswerQuestionOptions,
): Promise<string> {
  const context = await gatherWorkspaceContext(options.workspaceDir);
  const contextBlock = context
    ? `Workspace context (gathered locally; may be incomplete):\n${context}`
    : 'Workspace context: (no readable workspace context was found)';
  const messages: Message[] = [
    { role: 'system', content: QUESTION_SYSTEM_PROMPT },
    ...(options.history ?? []).slice(-6),
    { role: 'user', content: `${contextBlock}\n\nQuestion: ${input}` },
  ];
  const response = await provider.chat(messages);
  const text = messageText(response.message).trim();
  return text || questionFallbackReply();
}
