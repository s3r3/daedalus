export function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate());
  return `${date.getFullYear()}-${month}-${day}`;
}
