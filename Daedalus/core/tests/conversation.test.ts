import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONVERSATIONAL_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  answerConversational,
  answerQuestion,
  classifyChatIntent,
  conversationalFallbackReply,
  gatherWorkspaceContext,
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
    'lihat isi folder src',
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
