import { calculateTax } from './tax.js';

export function totalWithTax(subtotal) {
  const tax = calculateTax(subtotal);
  return subtotal + tax;
}
