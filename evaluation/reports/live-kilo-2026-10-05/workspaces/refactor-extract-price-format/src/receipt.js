export function receiptLine(name, cents) {
  const price = '$' + (cents / 100).toFixed(2);
  return `${name}: ${price}`;
}
