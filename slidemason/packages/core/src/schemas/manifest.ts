import { z } from 'zod';

const FileTypes = z.enum([
  'markdown', 'text', 'json', 'csv', 'image',
]);

export const ManifestFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: FileTypes,
  size: z.number(),
  modifiedAt: z.string(),
});

export const ManifestSchema = z.object({
  generatedAt: z.string(),
  dataDir: z.string(),
  files: z.array(ManifestFileSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
