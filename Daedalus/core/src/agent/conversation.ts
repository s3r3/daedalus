/**
 * Conversational chat path for interactive surfaces (CLI chat now, Web
 * composer later).
 *
 * A chat box is not a task queue: a greeting must not spin up the planner,
 * a plan, and a tool loop. `classifyChatIntent` deterministically decides
 * whether a submitted line is casual conversation or real work, and
 * `answerConversational` answers casual lines with a single tool-less
 * provider call — no TaskRunner, no plan, no task events.
 *
 * The classifier is intentionally tight and bias-to-task: any code, file,
 * action, or codebase signal routes to the task path (the current modes
 * keep their exact semantics there). Only clearly non-coding messages are
 * conversational. No LLM is involved, so it is fully unit-testable.
 */
import type { LLMProvider, Message } from '../providers/llm/types.ts';

export type ChatIntent = 'conversational' | 'task';

/** Persona for the tool-less conversational reply. */
export const CONVERSATIONAL_SYSTEM_PROMPT = [
  'You are Daedalus, an agentic coding assistant living in the user\'s terminal and web IDE.',
  'The user is making casual conversation, not asking for coding work (yet).',
  'Reply briefly and warmly, in the user\'s language and mix (Indonesian if they write',
  'Indonesian, English if English). Do not create plans, do not mention tools, and do',
  'not claim to have modified anything. If it fits naturally, end by inviting them to',
  'describe any coding task they have in mind.',
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
 * Strong work signals, checked FIRST: if any is present the message is a
 * task even when it starts with a greeting ("hai, tolong buatkan fungsi…").
 */
const TASK_SIGNAL_PATTERNS: RegExp[] = [
  // File names, extensions, paths, code fences.
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|json|ya?ml|toml|ini|md|txt|css|scss|less|html?|xml|sql|lock|env)\b/,
  /(^|\s)[\w@.-]+(\/[\w.@-]+)+\/?(\s|$)/,
  /```/,
  // Action verbs (Indonesian + English imperatives).
  /\b(fix|repair|debug|refactor|implement|create|generate|build|compile|deploy|install|uninstall|run|execute|add|remove|delete|update|upgrade|edit|change|modify|write|rewrite|rename|move|copy|migrate|optimize|review|audit|test|lint|perbaiki|benerin|buatkan|bikin(kan)?|tambah(kan)?|hapus(kan)?|ubah(i)?|ganti|jalankan|tulis(kan)?|sunting|pindah(kan)?|salin|buang|pasang|lepas|kerjakan|kerjain|selesaikan|analisis|analisa|cekkan|periksakan|jelaskan|terangkan|explain|describe)\b/,
  // Code / project nouns.
  /\b(file|kode|code|coding|ngoding|fungsi|function|method|class|kelas|interface|tipe|type|bug|error|exception|stack ?trace|repo(sitory)?|folder|direktori|directory|project|proyek|script|skrip|modul|module|package|endpoint|api|database|db|query|tabel|table|kolom|git|commit|branch|merge|rebase|npm|node|python|typescript|javascript|rust|golang|komponen|component|halaman|website|web|aplikasi|app|server|client|frontend|backend|variabel|variable|konstanta|loop|array|objek|object|string|boolean|integer|test case|unit test|testing|validasi|validation|build|lint|deploy|config|konfigurasi|setting|pengaturan file)\b/,
  // Asking about the codebase itself.
  /\b(file|kode|folder|repo|proyek|project|error|fungsi|script) (ini|itu|tersebut)\b/,
  /\b(kenapa|mengapa|kok|why).{0,30}(gagal|error|fail|rusak|berantakan|tidak jalan|nggak jalan|ga jalan)\b/,
];

/** File/action signals are the ones that always mean real work. */
const HARD_SIGNAL_PATTERNS: RegExp[] = TASK_SIGNAL_PATTERNS.slice(0, 4);

/** Pure knowledge questions ("apa itu …?") are chat, not repository work. */
const DEFINITION_QUESTION = /^(apa itu|apa yang dimaksud|what is|what's|pengertian|definisi|arti)\b/;

function hasTaskSignal(text: string): boolean {
  return TASK_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function hasHardSignal(text: string): boolean {
  return HARD_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

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

function isConversationalText(text: string): boolean {
  if (THANKS_PATTERN.test(text) || BYE_PATTERN.test(text) || IDENTITY_PATTERN.test(text)) return true;
  if (CAPABILITY_PATTERN.test(text)) return true;
  if (ACK_PATTERN.test(text) || PING_PATTERN.test(text)) return true;

  // Greetings, optionally followed by smalltalk ("selamat pagi, apa kabar").
  let rest = text;
  for (let i = 0; i < 3; i += 1) {
    const stripped = rest.replace(GREETING_PREFIX, '').trim();
    if (stripped === rest) break;
    rest = stripped;
  }
  if (rest !== text && rest === '') return true;
  if (SMALLTALK_REST.test(rest)) return true;

  const words = text.split(' ').filter(Boolean);
  // Short questions addressed to the assistant personally ("kamu suka kopi?").
  if (words.length <= 8 && /\b(kamu|kau|anda|you|daedalus)\b/.test(text)) return true;
  // Short general questions with no work signal ("cuaca" handled above by
  // length+signal rules; "gimana cara masak nasi?" is a chat question too).
  if (words.length <= MAX_CONVERSATIONAL_WORDS && QUESTION_STARTERS.test(text)) return true;

  return false;
}

/**
 * Classify one submitted chat line. `task` is the safe default; only
 * clearly conversational lines take the direct-reply path.
 */
export function classifyChatIntent(input: string): ChatIntent {
  const text = normalize(input);
  if (!text) return 'conversational';
  if (text.length > MAX_CONVERSATIONAL_CHARS) return 'task';
  // "Apa itu X?" is a knowledge question for chat unless it also carries a
  // real work signal (verb/file) — only bare nouns may be overridden.
  if (DEFINITION_QUESTION.test(text) && !hasHardSignal(text)) return 'conversational';
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
