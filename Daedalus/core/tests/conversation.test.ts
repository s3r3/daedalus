import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONVERSATIONAL_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  answerConversational,
  answerQuestion,
  answerWorkspaceQuestion,
  classifyChatIntent,
  conversationalFallbackReply,
  gatherWorkspaceContext,
  isWorkspaceContentQuestion,
  parseWorkspaceQARequest,
  questionFallbackReply,
  type LLMProvider,
  type Message,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-question-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'README.md'), '# Widget Kit\n\nA tiny kit of widgets for demos.\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'widget-kit', description: 'Widgets for demos' }));
  writeFileSync(join(dir, 'index.ts'), 'export const widget = 1;\n');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  mkdirSync(join(dir, '.git'));
  return dir;
}

describe('classifyChatIntent — conversational', () => {
  const conversational = [
    'hai',
    'Hai!',
    'halo',
    'hello',
    'hei',
    'selamat pagi',
    'Selamat pagi, apa kabar?',
    'apa kabar',
    'kamu siapa',
    'kamu siapa?',
    'siapa kamu',
    'who are you',
    'kamu bisa apa',
    'kamu bisa bantu apa',
    'terima kasih',
    'terima kasih banyak',
    'makasih ya',
    'thanks',
    'dadah',
    'sampai jumpa',
    'ok',
    'oke siap',
    'mantap',
    'ping',
    'tes',
    'cek dong',
    'apa itu typescript',
    'what is a monad',
    'kamu suka kopi?',
    'cuaca hari ini gimana',
  ];
  for (const input of conversational) {
    test(`"${input}" is conversational`, () => {
      expect(classifyChatIntent(input)).toBe('conversational');
    });
  }
});

describe('classifyChatIntent — task', () => {
  const tasks = [
    'fix bug di file login.ts',
    'perbaiki fungsi greet',
    'buatkan fungsi login',
    'tambah endpoint /users',
    'tolong refactor kode ini',
    'hai, tolong buatkan fungsi login',
    'halo, perbaiki error di src/app.ts',
    'selamat pagi, jalankan test-nya',
    'run npm test',
    'create a README',
    'buatkan landing page untuk kopi',
    'hai tolong fix bug ini',
    'buatkan fungsi X',
  ];
  for (const input of tasks) {
    test(`"${input}" is a task`, () => {
      expect(classifyChatIntent(input)).toBe('task');
    });
  }

  test('greeting prefix never swallows a real request', () => {
    expect(classifyChatIntent('hai, tolong buatkan fungsi login buat saya')).toBe('task');
    expect(classifyChatIntent('halo! bisa tolong cek file ini?')).toBe('task');
  });

  test('long messages default to task even without explicit signals', () => {
    const long = 'saya ingin bercerita panjang lebar tentang banyak hal yang terjadi minggu ini di kantor bersama teman teman semuanya';
    expect(long.length).toBeGreaterThan(90);
    expect(classifyChatIntent(long)).toBe('task');
  });
});

describe('classifyChatIntent — question', () => {
  const questions = [
    'repo ini tentang apa',
    'repo ini tentang apa?',
    'proyek ini buat apa',
    'jelaskan struktur repo ini',
    'jelaskan file ini',
    'file ini ngapain?',
    'kenapa test gagal?',
    'kenapa test ini gagal',
    'kenapa build gagal',
    'apa yang dilakukan file config.ts?',
    'apa fungsi file config.ts?',
    'apa fungsi file X',
    'gimana cara kerja agent loop-nya',
    'aku siapa',
    'aku siapa?',
    'hai kamu siapa dan aku siapa? dan repo ini tentang apa?',
    'hai, repo ini tentang apa?',
  ];
  for (const input of questions) {
    test(`"${input}" is a question`, () => {
      expect(classifyChatIntent(input)).toBe('question');
    });
  }

  test('an imperative verb vetoes the question path even inside a question frame', () => {
    expect(classifyChatIntent('kenapa kamu tidak fix bug ini')).toBe('task');
    expect(classifyChatIntent('gimana cara deploy aplikasi ini')).toBe('task');
  });
});

describe('classifyChatIntent — workspace-content questions (grounded Q&A)', () => {
  const questions = [
    // The old imperative-verb veto routed these into full tasks; they are
    // read-only questions and now take the direct-answer path instead.
    'lihat isi folder src',
    'tampilkan isi folder src',
    'hai, lihat isi folder src',
    'ada file apa aja di folder src',
    'ada file apa saja di src',
    'file apa aja yang ada di src',
    'daftar file di folder src',
    'isi file README apa',
    'isi file README.md',
    'tampilkan isi file config.ts',
    'apa isi folder src?',
    'di mana file config.ts',
    'dimana file index.ts',
    'list files in src',
    "what's in the src folder",
    'show me the content of README.md',
    'where is the config file',
  ];
  for (const input of questions) {
    test(`"${input}" is a question, not a task`, () => {
      expect(classifyChatIntent(input)).toBe('question');
      expect(isWorkspaceContentQuestion(input)).toBe(true);
    });
  }

  const stillTasks = [
    // Imperatives to modify/create/delete/run stay on the full task path.
    'buatkan file src/data.ts',
    'edit file src/index.ts',
    'jalankan npm test',
    'hapus file lama.ts',
    'tolong perbaiki fungsi ini',
    'tambah kolom baru ke tabel users',
    // Ambiguous/mixed lines fail toward the safe established path: task.
    'lihat isi folder src dan hapus yang tidak perlu',
    'tampilkan isi folder lalu refactor semuanya',
    'cek isi folder src terus perbaiki yang rusak',
    'baca file src/index.ts berulang kali dan analisis isinya',
  ];
  for (const input of stillTasks) {
    test(`"${input}" is still a task`, () => {
      expect(classifyChatIntent(input)).toBe('task');
      expect(isWorkspaceContentQuestion(input)).toBe(false);
    });
  }

  test('isWorkspaceContentQuestion needs a workspace-content phrase, not just a file mention', () => {
    expect(isWorkspaceContentQuestion('kenapa test ini gagal?')).toBe(false);
    expect(isWorkspaceContentQuestion('apa fungsi file config.ts?')).toBe(false);
    expect(isWorkspaceContentQuestion('halo! bisa tolong cek file ini?')).toBe(false);
  });
});

describe('answerConversational', () => {
  function stubProvider(reply: string, capture?: { messages?: Message[] }): LLMProvider {
    return {
      name: 'stub-chat',
      async chat(messages) {
        if (capture) capture.messages = messages;
        return { message: { role: 'assistant', content: reply } };
      },
      async *stream() {
        yield { type: 'delta', content: reply };
      },
    };
  }

  test('makes exactly one tool-less call with the Daedalus persona', async () => {
    const capture: { messages?: Message[] } = {};
    const reply = await answerConversational(stubProvider('Halo juga! 👋', capture), 'hai');
    expect(reply).toBe('Halo juga! 👋');
    expect(capture.messages?.[0]).toEqual({ role: 'system', content: CONVERSATIONAL_SYSTEM_PROMPT });
    expect(capture.messages?.[capture.messages.length - 1]).toEqual({ role: 'user', content: 'hai' });
  });

  test('includes recent history before the new line', async () => {
    const capture: { messages?: Message[] } = {};
    const history: Message[] = [
      { role: 'user', content: 'hai' },
      { role: 'assistant', content: 'Halo!' },
    ];
    await answerConversational(stubProvider('Baik, kamu?', capture), 'apa kabar', history);
    expect(capture.messages?.slice(1)).toEqual([
      ...history,
      { role: 'user', content: 'apa kabar' },
    ]);
  });

  test('falls back gracefully on an empty provider reply', async () => {
    const reply = await answerConversational(stubProvider('   '), 'hai');
    expect(reply).toBe(conversationalFallbackReply());
    expect(reply).toContain('Daedalus');
  });
});

describe('gatherWorkspaceContext', () => {
  test('lists depth-1 entries (minus node_modules/.git), README excerpt, and package.json identity', async () => {
    const dir = fixtureWorkspace();
    const context = await gatherWorkspaceContext(dir);
    expect(context).toContain('- README.md');
    expect(context).toContain('- src/');
    expect(context).toContain('- index.ts');
    expect(context).not.toContain('node_modules');
    expect(context).not.toContain('.git');
    expect(context).toContain('A tiny kit of widgets for demos.');
    expect(context).toContain('name: widget-kit');
    expect(context).toContain('description: Widgets for demos');
  });

  test('caps the README excerpt at 60 lines and tolerates a missing workspace', async () => {
    const dir = fixtureWorkspace();
    writeFileSync(join(dir, 'README.md'), Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));
    const context = await gatherWorkspaceContext(dir);
    expect(context).toContain('line 60');
    expect(context).not.toContain('line 61');
    await expect(gatherWorkspaceContext(join(dir, 'does-not-exist'))).resolves.toBe('');
  });
});

describe('answerWorkspaceQuestion — deterministic grounded answers, zero model calls', () => {
  function richWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'daedalus-workspace-qa-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'README.md'), '# Widget Kit\n\nA tiny kit of widgets for demos.\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'widget-kit', description: 'Widgets for demos' }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const widget = 1;\n');
    writeFileSync(join(dir, 'src', 'util.ts'), 'export const util = 2;\n');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n\nHow to use the kit.\n');
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    return dir;
  }

  test('parses the three single-shape operations', () => {
    expect(parseWorkspaceQARequest('lihat isi folder src')).toEqual({ kind: 'list', target: 'src', lang: 'id' });
    expect(parseWorkspaceQARequest('ada file apa aja di folder src')).toEqual({ kind: 'list', target: 'src', lang: 'id' });
    expect(parseWorkspaceQARequest('isi file README apa')).toEqual({ kind: 'read', target: 'readme', lang: 'id' });
    expect(parseWorkspaceQARequest('show me the content of README.md')).toEqual({ kind: 'read', target: 'readme.md', lang: 'en' });
    expect(parseWorkspaceQARequest('di mana file config.ts')).toEqual({ kind: 'locate', target: 'config.ts', lang: 'id', wantDir: false });
    expect(parseWorkspaceQARequest('where is the config file')).toEqual({ kind: 'locate', target: 'config', lang: 'en', wantDir: false });
  });

  test('returns null for mixed lines and synthesis questions (model fallback)', () => {
    expect(parseWorkspaceQARequest('apa fungsi file config.ts?')).toBeNull();
    expect(parseWorkspaceQARequest('jelaskan struktur repo ini')).toBeNull();
    expect(parseWorkspaceQARequest('lihat isi folder src dan hapus yang lama')).toBeNull();
    expect(parseWorkspaceQARequest('buatkan file x.ts')).toBeNull();
    expect(parseWorkspaceQARequest('repo ini tentang apa?')).toBeNull();
  });

  test('lists a folder without any provider', async () => {
    const dir = richWorkspace();
    const reply = await answerWorkspaceQuestion('lihat isi folder src', dir);
    expect(reply).toContain('Isi folder src/:');
    expect(reply).toContain('- index.ts');
    expect(reply).toContain('- util.ts');
    expect(reply).not.toContain('node_modules');

    const reply2 = await answerWorkspaceQuestion('ada file apa aja di folder docs', dir);
    expect(reply2).toContain('- guide.md');

    const replyEn = await answerWorkspaceQuestion("what's in the src folder", dir);
    expect(replyEn).toContain('Contents of src/:');
    expect(replyEn).toContain('- index.ts');
  });

  test('reads a file excerpt without any provider', async () => {
    const dir = richWorkspace();
    const reply = await answerWorkspaceQuestion('isi file README apa', dir);
    expect(reply).toContain('Isi file README.md:');
    expect(reply).toContain('A tiny kit of widgets for demos.');

    const reply2 = await answerWorkspaceQuestion('tampilkan isi file src/index.ts', dir);
    expect(reply2).toContain('export const widget = 1;');
  });

  test('locates a file by name', async () => {
    const dir = richWorkspace();
    const reply = await answerWorkspaceQuestion('di mana file guide.md', dir);
    expect(reply).toContain('docs/guide.md');

    const reply2 = await answerWorkspaceQuestion('dimana file index.ts', dir);
    expect(reply2).toContain('src/index.ts');
  });

  test('returns null for missing targets so the model path can answer honestly', async () => {
    const dir = richWorkspace();
    await expect(answerWorkspaceQuestion('lihat isi folder tidak-ada', dir)).resolves.toBeNull();
    await expect(answerWorkspaceQuestion('isi file tidak-ada.txt', dir)).resolves.toBeNull();
    await expect(answerWorkspaceQuestion('di mana file tidak-ada.txt', dir)).resolves.toBeNull();
  });

  test('never escapes the workspace', async () => {
    const dir = richWorkspace();
    await expect(answerWorkspaceQuestion('lihat isi folder ../../..', dir)).resolves.toBeNull();
    await expect(answerWorkspaceQuestion('isi file /etc/hostname', dir)).resolves.toBeNull();
  });

  test('is read-only: workspace content is byte-identical before and after', async () => {
    const dir = richWorkspace();
    const snapshot = new Map<string, string>();
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else snapshot.set(full, readFileSync(full, 'utf8'));
      }
    };
    const countFiles = (d: string): number => {
      let n = 0;
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        n += entry.isDirectory() ? countFiles(join(d, entry.name)) : 1;
      }
      return n;
    };
    walk(dir);
    const before = countFiles(dir);

    await answerWorkspaceQuestion('lihat isi folder src', dir);
    await answerWorkspaceQuestion('isi file README.md', dir);
    await answerWorkspaceQuestion('di mana file guide.md', dir);
    await answerWorkspaceQuestion("what's in the docs folder", dir);
    await answerWorkspaceQuestion('show me the content of package.json', dir);

    expect(countFiles(dir)).toBe(before);
    for (const [full, content] of snapshot) {
      expect(readFileSync(full, 'utf8')).toBe(content);
    }
  });
});

describe('answerQuestion', () => {
  function stubProvider(reply: string, capture?: { calls?: number; messages?: Message[]; tools?: unknown }): LLMProvider {
    return {
      name: 'stub-question',
      async chat(messages, tools) {
        if (capture) {
          capture.calls = (capture.calls ?? 0) + 1;
          capture.messages = messages;
          capture.tools = tools;
        }
        return { message: { role: 'assistant', content: reply } };
      },
      async *stream() {
        yield { type: 'delta', content: reply };
      },
    };
  }

  test('makes exactly one tool-less call grounded in the workspace context', async () => {
    const dir = fixtureWorkspace();
    const capture: { calls?: number; messages?: Message[]; tools?: unknown } = {};
    const reply = await answerQuestion(stubProvider('Ini repo widget-kit.', capture), 'repo ini tentang apa?', { workspaceDir: dir });
    expect(reply).toBe('Ini repo widget-kit.');
    expect(capture.calls).toBe(1);
    expect(capture.tools).toBeUndefined();
    expect(capture.messages?.[0]).toEqual({ role: 'system', content: QUESTION_SYSTEM_PROMPT });
    const asked = capture.messages?.[capture.messages.length - 1];
    expect(asked?.role).toBe('user');
    expect(String(asked?.content)).toContain('Workspace context');
    expect(String(asked?.content)).toContain('A tiny kit of widgets for demos.');
    expect(String(asked?.content)).toContain('- src/');
    expect(String(asked?.content)).toContain('name: widget-kit');
    expect(String(asked?.content)).toContain('Question: repo ini tentang apa?');
  });

  test('carries recent history and falls back on an empty provider reply', async () => {
    const dir = fixtureWorkspace();
    const capture: { messages?: Message[] } = {};
    const history: Message[] = [
      { role: 'user', content: 'hai' },
      { role: 'assistant', content: 'Halo!' },
    ];
    const reply = await answerQuestion(stubProvider('  ', capture), 'terus aku siapa?', { workspaceDir: dir, history });
    expect(reply).toBe(questionFallbackReply());
    expect(capture.messages?.slice(1, 3)).toEqual(history);
  });
});
