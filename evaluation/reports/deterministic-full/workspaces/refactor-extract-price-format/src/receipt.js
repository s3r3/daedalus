import { formatPrice } from './format.js';

export function receiptLine(name, cents) {
  return `${name}: ${formatPrice(cents)}`;
}
