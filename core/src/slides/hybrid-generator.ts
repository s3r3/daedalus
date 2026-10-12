import { randomUUID } from 'node:crypto';

export type HybridSlideOutlineItem = {
  page: number;
  title: string;
  content: string;
  designNotes?: {
    layout: string;
    style: string;
    emphasis: string[];
  };
};

export type HybridSlidePrompt = {
  page: number;
  title: string;
  display_content: string;
  prompt: string;
};

export type HybridSlideRequest = {
  topic: string;
  n_slides?: number;
  language?: string;
  tone?: string;
  style?: string;
};

/**
 * Deterministic, topic-aware outline planner for the hybrid slide
 * workflow. This replaces the previous generator, which stapled the
 * same generic headings — and the same hard-coded biology filler text —
 * onto every topic. The planner derives the deck's structure from the
 * topic itself:
 *
 * - Facets: the topic is split on explicit separators (":", ",", "dan",
 *   …) so a compound topic yields one slide angle per named facet.
 * - Narrative arc: a fixed opener → exploration → insight → closing
 *   progression, filled from the facet/angle pool until the requested
 *   slide count is met exactly.
 * - Layouts: each arc role maps to a real layout from the canonical
 *   catalog (title/section/bullets/timeline/diagram-flow/comparison/
 *   quote/closing/…), chosen by the slide's job — never one layout for
 *   the whole deck.
 *
 * Structure only: slide text is phrased as elaboration prompts anchored
 * to the topic ("Jelaskan … dalam konteks X"), never as asserted facts
 * about the subject, invented statistics, or quotes. The model (or the
 * author) supplies the actual substance inside this scaffold.
 */

function clampSlides(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.max(1, Math.floor(Number(value))) : 8;
  return Math.min(12, n);
}

type Lang = 'id' | 'en';

function langOf(language: string | undefined): Lang {
  const raw = (language ?? '').trim().toLowerCase();
  return raw.startsWith('en') || raw.includes('english') || raw.includes('inggris') ? 'en' : 'id';
}

/** Split a compound topic into its named facets; a simple topic stays whole. */
function facetsOf(topic: string): string[] {
  const parts = topic
    .split(/\s*[:;|]\s*|\s*—\s*|\s*–\s*|,\s*|\s+dan\s+|\s+and\s+|\s*&\s*/i)
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0);
  const seen = new Set<string>();
  const facets: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facets.push(part);
    if (facets.length >= 4) break;
  }
  return facets.length > 0 ? facets : [topic];
}

function cap(text: string): string {
  return text.length > 92 ? `${text.slice(0, 89).trimEnd()}…` : text;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

type ArcRole = {
  key: string;
  layout: string;
  title: (subject: string, facet: string) => string;
  bullets: (subject: string, facet: string) => string[];
  emphasis: (subject: string, facet: string) => string;
};

const ROTATING_CONTENT_LAYOUTS = ['bullets', 'two-column', 'icon-grid', 'image-side'] as const;

function buildArc(lang: Lang, chronological: boolean): { opener: ArcRole[]; pool: ArcRole[]; closer: ArcRole[] } {
  const L = lang === 'en'
    ? {
        background: 'Background', overview: 'Overview', keyAspects: 'Key Aspects', details: 'Important Details',
        process: 'Process & Development', journey: 'Journey', comparison: 'Comparative View',
        examples: 'Examples & Applications', insight: 'Key Insight', challenges: 'Challenges & Discussion',
        conclusion: 'Conclusion', closing: 'Closing & Next Steps',
      }
    : {
        background: 'Latar Belakang', overview: 'Gambaran Umum', keyAspects: 'Aspek-Aspek Utama', details: 'Rincian Penting',
        process: 'Proses & Perkembangan', journey: 'Perjalanan', comparison: 'Perbandingan',
        examples: 'Contoh & Penerapan', insight: 'Wawasan Kunci', challenges: 'Tantangan & Diskusi',
        conclusion: 'Kesimpulan', closing: 'Penutup & Langkah Berikutnya',
      };

  const ask = (en: string, id: string): string => (lang === 'en' ? en : id);

  const angleRoles: ArcRole[] = [
    {
      key: 'overview',
      layout: 'bullets',
      title: (subject) => cap(`${L.overview}: ${subject}`),
      bullets: (subject) => [
        ask(`What ${subject} is: scope, boundaries, and core ideas at a glance.`, `Apa itu ${subject}: ruang lingkup, batasan, dan gagasan intinya sekilas.`),
        ask(`The main parts or aspects that make up ${subject}.`, `Bagian atau aspek utama yang membentuk ${subject}.`),
        ask(`Terms and concepts the audience needs before going deeper into ${subject}.`, `Istilah dan konsep yang perlu dikenal audiens sebelum masuk lebih dalam ke ${subject}.`),
      ],
      emphasis: (subject) => `${L.overview} ${subject}`,
    },
    {
      key: 'process',
      layout: chronological ? 'timeline' : 'diagram-flow',
      title: (subject) => cap(`${chronological ? L.journey : L.process}: ${subject}`),
      bullets: (subject) => [
        ask(`The stages or steps that shape ${subject}, in order.`, `Tahapan atau langkah yang membentuk ${subject}, secara berurutan.`),
        ask(`What changes at each stage of ${subject}, and why it matters.`, `Apa yang berubah di setiap tahap ${subject}, dan mengapa itu penting.`),
        ask(`Turning points the audience should remember about ${subject}.`, `Titik balik yang perlu diingat audiens tentang ${subject}.`),
      ],
      emphasis: (subject) => `${chronological ? L.journey : L.process} ${subject}`,
    },
    {
      key: 'examples',
      layout: 'icon-grid',
      title: (subject) => cap(`${L.examples}: ${subject}`),
      bullets: (subject) => [
        ask(`Concrete examples that make ${subject} tangible for the audience.`, `Contoh konkret yang membuat ${subject} terasa nyata bagi audiens.`),
        ask(`Where ${subject} shows up in practice, and what it produces.`, `Di mana ${subject} muncul dalam praktik, dan hasil yang ditimbulkannya.`),
        ask(`One example worth walking through in detail for ${subject}.`, `Satu contoh tentang ${subject} yang layak dibedah lebih rinci.`),
      ],
      emphasis: (subject) => `${L.examples} ${subject}`,
    },
    {
      key: 'comparison',
      layout: 'comparison',
      title: (subject) => cap(`${L.comparison}: ${subject}`),
      bullets: (subject) => [
        ask(`Two sides or approaches within ${subject} worth contrasting.`, `Dua sisi atau pendekatan dalam ${subject} yang layak dibandingkan.`),
        ask(`Where the two sides of ${subject} agree, and where they differ.`, `Di mana kedua sisi ${subject} sejalan, dan di mana mereka berbeda.`),
        ask(`What the comparison reveals about ${subject} overall.`, `Apa yang diungkap perbandingan ini tentang ${subject} secara keseluruhan.`),
      ],
      emphasis: (subject) => `${L.comparison} ${subject}`,
    },
    {
      key: 'aspects',
      layout: 'two-column',
      title: (subject) => cap(`${L.keyAspects}: ${subject}`),
      bullets: (subject) => [
        ask(`Break ${subject} down into its main aspects or components.`, `Uraikan ${subject} menjadi aspek-aspek atau komponen utamanya.`),
        ask(`Which aspects of ${subject} matter most, and why.`, `Aspek ${subject} mana yang paling penting, dan alasannya.`),
        ask(`How the aspects of ${subject} relate to one another.`, `Bagaimana aspek-aspek ${subject} saling berhubungan.`),
      ],
      emphasis: (subject) => `${L.keyAspects} ${subject}`,
    },
    {
      key: 'details',
      layout: 'bullets',
      title: (subject) => cap(`${L.details}: ${subject}`),
      bullets: (subject) => [
        ask(`Details and specifics about ${subject} that deserve a closer look.`, `Rincian dan hal spesifik tentang ${subject} yang layak dicermati.`),
        ask(`Facts, figures, or examples the audience should note about ${subject}.`, `Fakta, angka, atau contoh tentang ${subject} yang perlu dicatat audiens.`),
        ask(`What these details change about how ${subject} is understood.`, `Apa yang diubah rincian ini terhadap cara memahami ${subject}.`),
      ],
      emphasis: (subject) => `${L.details} ${subject}`,
    },
    {
      key: 'insight',
      layout: 'quote',
      title: (subject) => cap(`${L.insight}: ${subject}`),
      bullets: (subject) => [
        ask(`The single most important takeaway about ${subject}.`, `Pesan terpenting yang harus dibawa pulang audiens tentang ${subject}.`),
        ask(`A common misunderstanding about ${subject} that this corrects.`, `Kesalahpahaman umum tentang ${subject} yang diluruskan bagian ini.`),
      ],
      emphasis: (subject) => `${L.insight} ${subject}`,
    },
    {
      key: 'challenges',
      layout: 'two-column',
      title: (subject) => cap(`${L.challenges}: ${subject}`),
      bullets: (subject) => [
        ask(`Open questions and difficulties that remain around ${subject}.`, `Pertanyaan terbuka dan kesulitan yang masih menyertai ${subject}.`),
        ask(`Points of debate or differing views on ${subject}.`, `Poin perdebatan atau perbedaan pandangan mengenai ${subject}.`),
        ask(`What would move the discussion on ${subject} forward.`, `Hal yang dapat memajukan pembahasan tentang ${subject}.`),
      ],
      emphasis: (subject) => `${L.challenges} ${subject}`,
    },
  ];

  return {
    opener: [
      {
        key: 'title',
        layout: 'title',
        title: (subject) => cap(subject),
        bullets: (subject) => [
          ask(`A presentation on ${subject}: what it covers and who it is for.`, `Presentasi tentang ${subject}: cakupan materi dan sasaran audiensnya.`),
          ask(`How the material on ${subject} is organized, from opening to closing.`, `Bagaimana materi tentang ${subject} disusun, dari pembuka sampai penutup.`),
        ],
        emphasis: (subject) => subject,
      },
      {
        key: 'background',
        layout: 'bullets',
        title: (subject) => cap(`${L.background}: ${subject}`),
        bullets: (subject) => [
          ask(`Why ${subject} matters and deserves a closer look.`, `Mengapa ${subject} penting dan layak dibahas lebih dalam.`),
          ask(`Context the audience needs before exploring ${subject}.`, `Konteks yang dibutuhkan audiens sebelum menjelajahi ${subject}.`),
          ask(`The key questions this presentation answers about ${subject}.`, `Pertanyaan kunci tentang ${subject} yang dijawab presentasi ini.`),
        ],
        emphasis: (subject) => `${L.background} ${subject}`,
      },
    ],
    pool: [...angleRoles],
    closer: [
      {
        key: 'conclusion',
        layout: 'bullets',
        title: (subject) => cap(`${L.conclusion}: ${subject}`),
        bullets: (subject) => [
          ask(`Recap of the main points covered about ${subject}.`, `Rekap poin-poin utama yang telah dibahas tentang ${subject}.`),
          ask(`Conclusions that follow from the material on ${subject}.`, `Simpulan yang dapat ditarik dari materi tentang ${subject}.`),
        ],
        emphasis: (subject) => `${L.conclusion} ${subject}`,
      },
      {
        key: 'closing',
        layout: 'closing',
        title: (subject) => cap(`${L.closing}: ${subject}`),
        bullets: (subject) => [
          ask(`Concrete next steps for the audience after learning ${subject}.`, `Langkah konkret berikutnya bagi audiens setelah mempelajari ${subject}.`),
          ask(`Where to explore ${subject} further.`, `Ke mana audiens dapat mengeksplorasi ${subject} lebih lanjut.`),
        ],
        emphasis: (subject) => `${L.closing} ${subject}`,
      },
    ],
  };
}

export function buildHybridSlideOutline(input: HybridSlideRequest): HybridSlideOutlineItem[] {
  const subject = (input.topic ?? '').trim().replace(/\s+/g, ' ') || 'Presentasi';
  const nSlides = clampSlides(input.n_slides);
  const lang = langOf(input.language);
  const style = input.style?.trim() || 'modern educational';
  const chronological = /(sejarah|history|perkembangan|evolusi|perjalanan|timeline|era\b)/i.test(subject);
  const facets = facetsOf(subject);
  const arc = buildArc(lang, chronological);

  // Assemble the arc for the exact requested count: title first, closing
  // last, and the middle filled from facet slides then angle roles.
  const facetRoles = facets.length > 1
    ? facets.map((_facet, i) => buildArcFacet(lang, i))
    : [];
  const facetSlides = facets.length > 1 ? facets.map((facet, i) => ({ role: facetRoles[i]!, facet })) : [];
  const angleSlides = arc.pool.map((role) => ({ role, facet: subject }));
  // When the topic has several named facets, the facet slides lead the
  // middle; the angle roles follow if more slides are needed.
  const pool = [...facetSlides, ...angleSlides];

  const picked: Array<{ role: ArcRole; facet: string }> = [];
  picked.push({ role: arc.opener[0]!, facet: subject });
  if (nSlides >= 3) picked.push({ role: arc.opener[1]!, facet: subject });
  const reservedTail = nSlides >= 4 ? 2 : nSlides >= 2 ? 1 : 0;
  const middleSlots = Math.max(0, nSlides - picked.length - reservedTail);
  for (let i = 0; i < middleSlots && i < pool.length; i += 1) picked.push(pool[i]!);
  // If the pool ran out (very large n), keep filling with remaining
  // angle roles keyed to each facet so no slide is ever a duplicate.
  if (picked.length < nSlides - reservedTail) {
    const extras = facets.flatMap((facet) => angleSlides.map((s) => ({ role: s.role, facet })));
    let guard = 0;
    while (picked.length < nSlides - reservedTail && guard < extras.length) {
      const extra = extras[guard]!;
      guard += 1;
      if (!picked.some((p) => p.role.key === extra.role.key && p.facet === extra.facet)) picked.push(extra);
    }
  }
  if (nSlides >= 4) picked.push({ role: arc.closer[0]!, facet: subject });
  if (nSlides >= 2) picked.push({ role: arc.closer[1]!, facet: subject });

  return picked.slice(0, nSlides).map(({ role, facet }, i) => {
    const title = role.title(subject, facet);
    const bullets = role.bullets(subject, facet);
    const content = [`## ${title}`, '', ...bullets.map((b) => `- ${b}`)].join('\n');
    return {
      page: i + 1,
      title,
      content,
      designNotes: {
        layout: role.layout,
        style,
        emphasis: [role.emphasis(subject, facet), subject],
      },
    };
  });
}

function buildArcFacet(lang: Lang, index: number): ArcRole {
  const layouts = ROTATING_CONTENT_LAYOUTS;
  const ask = (en: string, id: string): string => (lang === 'en' ? en : id);
  return {
    key: `facet-${index}`,
    layout: layouts[index % layouts.length]!,
    title: (_subject, facet) => cap(capitalize(facet)),
    bullets: (subject, facet) => [
      ask(`Explain ${facet} within the scope of ${subject}.`, `Jelaskan ${facet} dalam cakupan ${subject}.`),
      ask(`Key points and details that matter most about ${facet}.`, `Poin-poin dan rincian terpenting seputar ${facet}.`),
      ask(`How ${facet} connects to the rest of ${subject}.`, `Bagaimana ${facet} terhubung dengan keseluruhan ${subject}.`),
    ],
    emphasis: (_subject, facet) => facet,
  };
}

export function validateHybridSlideOutline(
  slides: HybridSlideOutlineItem[],
  expectedCount: number,
): string[] {
  const issues: string[] = [];

  if (slides.length !== expectedCount) {
    issues.push(`Expected exactly ${expectedCount} slides, got ${slides.length}.`);
  }

  slides.forEach((slide, index) => {
    const pageNo = index + 1;
    if (slide.page !== pageNo) {
      issues.push(`Slide ${index + 1} page mismatch: expected ${pageNo}, got ${slide.page}.`);
    }
    if (!slide.title || slide.title.trim().length === 0) {
      issues.push(`Slide ${pageNo} is missing a title.`);
    }
    if (!slide.content || slide.content.trim().length < 100) {
      issues.push(`Slide ${pageNo} content is too short (${(slide.content || '').trim().length} chars).`);
    }
    if (slide.content.length > 1200) {
      issues.push(`Slide ${pageNo} content exceeds 1200 characters.`);
    }
    if (!slide.content.includes('##')) {
      issues.push(`Slide ${pageNo} must use Markdown heading format.`);
    }
  });

  return issues;
}

export function buildHybridSlidePrompts(slides: HybridSlideOutlineItem[]): HybridSlidePrompt[] {
  return slides.map((slide) => {
    const prompt = [
      `Create a polished educational slide about: ${slide.title}`,
      'Use a clean, readable layout with strong hierarchy and concise supporting bullets.',
      'Keep the content audience-facing and suitable for a presentation deck.',
      `Context: ${slide.content}`,
      `Style: ${slide.designNotes?.style ?? 'modern educational'}`,
    ].join('\n');

    return {
      page: slide.page,
      title: slide.title,
      display_content: slide.content,
      prompt,
    };
  });
}

export function createHybridSlideMarkdown(slides: HybridSlideOutlineItem[]): string {
  const blocks = slides.map((slide) => {
    const safeTitle = slide.title.replace(/^\d+\.\s*/, '');
    return `# ${safeTitle}\n\n${slide.content}`;
  });
  return blocks.join('\n\n---\n\n');
}

export function buildHybridSlideDraft(topic: string, nSlides: number): {
  outline: HybridSlideOutlineItem[];
  prompts: HybridSlidePrompt[];
  markdown: string;
  issues: string[];
} {
  const outline = buildHybridSlideOutline({ topic, n_slides: nSlides, language: 'Indonesia', tone: 'profesional', style: 'modern educational' });
  const issues = validateHybridSlideOutline(outline, nSlides);
  const prompts = buildHybridSlidePrompts(outline);
  const markdown = createHybridSlideMarkdown(outline);

  return { outline, prompts, markdown, issues };
}

export function buildHybridSlideTaskId(): string {
  return `slide-${randomUUID().slice(0, 8)}`;
}
