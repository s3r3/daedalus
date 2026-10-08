import { BriefSchema } from './schemas/brief.js';
import { OutlineSchema } from './schemas/outline.js';

type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; errors: string[] };

export function validateBrief(data: unknown): ValidationResult {
  const result = BriefSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}

export function validateOutline(data: unknown): ValidationResult {
  const result = OutlineSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
