/**
 * «Dividi a metà» — the arithmetic of halving ONE existing cashflow row.
 *
 * Amounts are stored as signed floats ending in cents, so half is rounded to the cent and never
 * reaches zero: a row of 0,01 € cannot be halved, nor can one whose half would round back to
 * itself. The action itself (the signed write, the accounts and the property's debt it moves)
 * lives in lib/services/expenseHalvingService.ts; this module is the pure rule its tests pin.
 */
export function halvedAmount(amount: number): number | null {
  const absolute = Math.abs(amount);
  if (!Number.isFinite(absolute)) return null;
  const halved = Math.round(absolute * 50) / 100;
  return halved > 0 && halved < absolute ? halved : null;
}
