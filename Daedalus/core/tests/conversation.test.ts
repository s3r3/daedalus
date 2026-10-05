import { describe, expect, test } from 'vitest';
import {
  CONVERSATIONAL_SYSTEM_PROMPT,
  answerConversational,
  classifyChatIntent,
  conversationalFallbackReply,
  type LLMProvider,
  type Message,
} from '../src/index.ts';

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
    'jelaskan file ini',
    'file ini ngapain?',
    'kenapa test gagal?',
    'tolong refactor kode ini',
    'hai, tolong buatkan fungsi login',
    'halo, perbaiki error di src/app.ts',
    'selamat pagi, jalankan test-nya',
    'run npm test',
    'lihat isi folder src',
    'create a README',
    'buatkan landing page untuk kopi',
    'apa yang dilakukan file config.ts?',
    'gimana cara kerja agent loop-nya',
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
