import { AppError } from './errors';

export function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(400, 'AMOUNT_OUT_OF_RANGE', 'Amount or count exceeds the supported integer range');
  return Number(value);
}
export function parseMoney(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new AppError(400, 'INVALID_MONEY', 'Use a nonnegative decimal string with at most two fractional digits');
  const [whole = '0', fraction = ''] = value.split('.');
  return safeInteger(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
// Reports can exceed a single order's bound, so formatting also accepts BigInt.
export function formatMoney(value: number | bigint): string {
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
export function calculateTotals(subtotal: number, percent = 0) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('Invalid discount percentage');
  const discount = safeInteger(BigInt(subtotal) * BigInt(percent) / 100n);
  return { subtotalMinor: subtotal, discountMinor: discount, totalMinor: subtotal - discount };
}
