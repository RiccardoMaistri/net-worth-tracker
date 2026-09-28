/**
 * The expense-type colour map exists twice by necessity — Tailwind class literals for the dots
 * and badges, CSS values for what paints through `style` — so this pins the two together, slot by
 * slot: a moved slot in one map and not the other turns it red.
 */

import { describe, expect, it } from 'vitest';
import { EXPENSE_TYPE_BADGE_CLASS, EXPENSE_TYPE_COLOR_VAR, EXPENSE_TYPE_DOT_CLASS } from '@/lib/constants/expenseTypeColors';
import type { ExpenseType } from '@/types/expenses';

const TYPES: ExpenseType[] = ['income', 'fixed', 'variable', 'debt', 'transfer'];

/** `bg-[var(--chart-1)]` → `var(--chart-1)`; `bg-positive` (a theme utility) → `var(--positive)`. */
function colorOfDotClass(className: string): string | null {
  const arbitrary = className.match(/^bg-\[(var\(--[\w-]+\))\]$/);
  if (arbitrary) return arbitrary[1];
  const token = className.match(/^bg-([\w-]+)$/);
  return token ? `var(--${token[1]})` : null;
}

describe('EXPENSE_TYPE_COLOR_VAR', () => {
  it.each(TYPES)('paints %s on the same token as its dot', (type) => {
    expect(colorOfDotClass(EXPENSE_TYPE_DOT_CLASS[type])).toBe(EXPENSE_TYPE_COLOR_VAR[type]);
  });

  it.each(TYPES)('paints %s on the same token as its badge text', (type) => {
    const token = EXPENSE_TYPE_COLOR_VAR[type].replace(/^var\(--([\w-]+)\)$/, '$1');
    const badgeText = EXPENSE_TYPE_BADGE_CLASS[type].split(' ').find((cls) => cls.startsWith('text-'));
    expect([`text-${token}`, `text-[var(--${token})]`]).toContain(badgeText);
  });
});
