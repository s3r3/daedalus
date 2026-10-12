export function slugify(text) {
  return text.trim().replace(/^-+|-+$/g, '');
}
