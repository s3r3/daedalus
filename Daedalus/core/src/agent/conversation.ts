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
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const DEFINITION_QUESTION = /^(apa itu|apa yang dimaksud|what is|what's|pengertian|definisi|arti)\b/;

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
