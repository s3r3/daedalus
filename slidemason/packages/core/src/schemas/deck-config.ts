import { z } from 'zod';

export const DeckConfigSchema = z.object({
  title: z.string(),
  theme: z.string().default('slate'),
  slides: z.array(z.string()),
});

export type DeckConfig = z.infer<typeof DeckConfigSchema>;
