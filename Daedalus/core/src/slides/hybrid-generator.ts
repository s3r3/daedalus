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

function clampSlides(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.max(1, Math.floor(Number(value))) : 8;
  return Math.min(12, n);
}

function sentenceCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^\w|\s\w)/g, (m) => m.toUpperCase());
}

export function buildHybridSlideOutline(input: HybridSlideRequest): HybridSlideOutlineItem[] {
  const topic = input.topic.trim() || 'Biologi';
  const nSlides = clampSlides(input.n_slides);
  const language = input.language?.trim() || 'Indonesia';
  const tone = input.tone?.trim() || 'profesional';
  const style = input.style?.trim() || 'modern educational';

  const topics = [
    'Pengenalan umum',
    'Konsep dasar',
    'Struktur dan fungsi',
    'Proses penting',
    'Contoh dalam kehidupan',
    'Interaksi antar sistem',
    'Manfaat dan aplikasi',
    'Kesimpulan',
    'Tantangan dan masa depan',
    'Ringkasan akhir',
    'Refleksi',
    'Penutup',
  ];

  const slides: HybridSlideOutlineItem[] = [];
  for (let i = 0; i < nSlides; i += 1) {
    const titleSeed = topics[i % topics.length] ?? 'Topik';
    const title = `${i + 1}. ${sentenceCase(titleSeed)} ${topic}`;
    const content = [
      `## ${title}`,
      '',
      `- ${topic} adalah bidang ilmu yang mempelajari kehidupan, organisme, dan proses yang menjaga keberlangsungan kehidupan.`,
      `- Fokus utama pada ${titleSeed.toLowerCase()} membantu memahami bagaimana sistem biologis bekerja secara terstruktur dan berkesinambungan.`,
      `- Dalam konteks ${language}, materi ini disajikan dengan gaya ${tone} agar mudah dipahami oleh audiens yang ingin mempelajari dasar-dasar ${topic.toLowerCase()}.`,
      `- Contoh nyata menunjukkan bahwa konsep ${topic.toLowerCase()} berhubungan erat dengan kesehatan, lingkungan, dan perkembangan makhluk hidup sehari-hari.`,
      `- Kesimpulan dari bagian ini menegaskan pentingnya memahami hubungan antara teori, observasi, dan aplikasi praktis di kehidupan nyata.`,
    ].join('\n');

    slides.push({
      page: i + 1,
      title,
      content,
      designNotes: {
        layout: i % 2 === 0 ? 'bullets' : 'two-column',
        style,
        emphasis: [`${titleSeed} ${topic}`, 'konteks nyata', 'ringkasan penting'],
      },
    });
  }

  return slides;
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
