import type { SpendingRole } from '@/types/expenses';

/**
 * The ONE map from a 50/30/20 bucket to its theme token, read by the three places that paint a
 * role (Rule of Three): the Sankey's palette (FlussoTile, through useCssColorTokens), the phone's
 * share bar (SpendingRolesMobileFlow) and the Impostazioni category badge (`categoryRoleColor`).
 *
 * The tokens are aliases declared once in app/globals.css :root on the theme's own chart slots, so
 * a theme may name its own. The keys are the buckets of `SpendingBucket` (lib/utils/spendingRoles.ts)
 * plus `deficit`, the «Coperto dal patrimonio» source — written out from `SpendingRole` here so this
 * module does not import the resolver that imports it.
 *
 * Module-level and never rebuilt: useCssColorTokens depends on the object's identity.
 */
export const SPENDING_ROLE_TOKEN: Readonly<Record<SpendingRole | 'unclassified' | 'deficit', string>> = {
  need: '--role-need',
  want: '--role-want',
  saving: '--role-saving',
  unclassified: '--role-unclassified',
  deficit: '--role-deficit',
};

/** The bucket's colour as a CSS value, for what paints through `style` or a badge. */
export function spendingRoleColorVar(bucket: keyof typeof SPENDING_ROLE_TOKEN): string {
  return `var(${SPENDING_ROLE_TOKEN[bucket]})`;
}
