export function totalWithTax(subtotal) {
  const tax = subtotal * 0.2;
  return subtotal + tax;
}
