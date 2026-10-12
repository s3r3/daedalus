import { calculateTax } from './tax.js';

export function totalWithTax(subtotal) {
  return subtotal + calculateTax(subtotal);
}
