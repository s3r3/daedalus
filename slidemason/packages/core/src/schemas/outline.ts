import { z } from 'zod';

const SlideTypes = z.enum([
  // Original 12
  'title-hero', 'agenda', 'section-divider', 'two-column-argument',
  'quote-insight', 'stat-grid', 'image-caption', 'comparison-table',
  'timeline', 'roadmap', 'recommendation-ask', 'appendix',
  // New 28
  'icon-features', 'data-dashboard', 'process-overview', 'funnel-breakdown',
  'cycle-explainer', 'flywheel', 'swot-analysis', 'pros-cons',
  'before-after', 'versus-matchup', 'team-intro', 'testimonial-spotlight',
  'pricing-overview', 'screenshot-demo', 'image-story', 'data-comparison',
  'numbers-impact', 'quadrant-analysis', 'org-structure', 'flow-decision',
  'gap-bridge', 'radar-comparison', 'heatmap-view', 'score-card',
  'next-steps-action', 'contact-end', 'chapter-opener', 'logo-showcase',
]);

export const SlideEntrySchema = z.object({
  id: z.string().min(1),
  type: SlideTypes,
  intent: z.string().min(1),
  headline: z.string().min(1),
  subheadline: z.string().optional(),
  components: z.array(z.string()).default([]),
  copyPoints: z.array(z.string()).optional(),
  notesSeed: z.string().optional(),
  visual: z.string().optional(),
});

export const OutlineSchema = z.object({
  theme: z.string().default('slate'),
  slides: z.array(SlideEntrySchema).min(1),
});

export type Outline = z.infer<typeof OutlineSchema>;
export type SlideEntry = z.infer<typeof SlideEntrySchema>;
