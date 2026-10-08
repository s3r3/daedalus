import { z } from 'zod';

export const BriefSourceSchema = z.object({
  file: z.string(),
  type: z.string(),
  summary: z.string(),
});

export const BriefSchema = z.object({
  title: z.string().min(1),
  audience: z.string().min(1),
  goal: z.string().min(1),
  tone: z.string().min(1),
  themes: z.array(z.string()),
  sources: z.array(BriefSourceSchema),
  constraints: z.array(z.string()).default([]),
});

export type Brief = z.infer<typeof BriefSchema>;
