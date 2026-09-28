'use client';

/**
 * Flusso's 50/30/20 view below 640px: the 50/30/20 bar with the reference ticks, then each role's
 * categories as ranked rows. Drawn by FlowShareMobile.
 *
 * Every figure and every word comes from the pure layer: the shares from
 * `summarizeSpendingRoleShares` — the SAME source `describeSpendingRolesFlow` prints above the bar,
 * so the legend and the sentence cannot disagree by a rounding — and the caption, the surplus note
 * and the empty line from analisiNarrative.ts. The bar's base is what left the budget (income plus
 * what the wealth covered); a deficit is the red «entrate» line, clamped onto the bar.
 */

import type { ExpenseType } from '@/types/expenses';
import type { ScheduledSlice } from '@/lib/utils/tracciamentoSummary';
import { labelRoleSlices, summarizeSpendingRoleShares, type SpendingRolesSummary } from '@/lib/utils/spendingRoles';
import { describeFlowSurplus, describeShareCompact, describeSpendingRolesBar } from '@/lib/utils/analisiNarrative';
import { spendingRoleColorVar } from '@/lib/constants/spendingRoleColors';
import { FlowShareMobile, type FlowShareGroup } from '@/components/cashflow/analisi/FlowShareMobile';

/**
 * The 50/30/20 reference: needs up to 50, needs + wants up to 80. If these move, move the words too:
 * describeSpendingRolesBar says «tacche a 50 e 80».
 */
const RULE_TICKS = [50, 80] as const;

interface Props {
  summary: SpendingRolesSummary;
  /** The period's not-yet-happened slice (AnalisiTab's `scheduled`, the verdict's own), for the surplus note. */
  scheduled: ScheduledSlice;
  /** How far that calendar reaches (`describeAnalisiScheduledHorizon`). */
  horizon: string | null;
  onEntityClick: (target: { expenseType: ExpenseType; categoryKey: string }) => void;
}

export function SpendingRolesMobileFlow({ summary, scheduled, horizon, onEntityClick }: Props) {
  const roleShares = summarizeSpendingRoleShares(summary);

  const groups: FlowShareGroup[] = roleShares.shares.map((share) => ({
    key: share.bucket,
    label: share.label,
    color: spendingRoleColorVar(share.bucket),
    total: share.amount,
    // Two categories of one role can share a name (a fixed «Casa» and a variable one): the rows
    // then carry their type, or the list would print the same word twice.
    categories: labelRoleSlices(summary.byBucket[share.bucket].categories),
    // Risparmi's surplus has no category row: it is said under the group, «Più …» after saving rows.
    note:
      share.bucket === 'saving'
        ? describeFlowSurplus({ surplus: roleShares.surplus, afterRows: roleShares.saved > 0, scheduled, horizon })
        : null,
  }));

  return (
    <FlowShareMobile
      absence={roleShares.absence}
      bar={{
        segments: roleShares.shares.map((share) => ({
          key: share.bucket,
          label: share.label,
          percentage: share.percentage,
          printed: describeShareCompact(share.percentage),
          color: spendingRoleColorVar(share.bucket),
        })),
        ariaLabel: 'Quote per ruolo, sul riferimento 50/30/20',
        ticks: RULE_TICKS,
        incomeEdge: roleShares.incomeEdge,
        caption: describeSpendingRolesBar(roleShares),
      }}
      groups={groups}
      onEntityClick={onEntityClick}
    />
  );
}
