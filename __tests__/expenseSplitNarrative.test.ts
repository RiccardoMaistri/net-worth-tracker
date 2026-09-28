import { describe, it, expect, vi } from 'vitest';

// chartService's it-IT formatters carry the Firebase chain with them — mocked exactly as
// __tests__/cashflowNarrative.test.ts does, so the module under test stays pure.
vi.mock('@/lib/firebase/config', () => ({ db: {} }));
vi.mock('@/lib/utils/authFetch', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('@/lib/services/dashboardOverviewInvalidation', () => ({
  invalidateDashboardOverviewSummary: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  deleteField: vi.fn(),
}));

import {
  buildSplitVerdict,
  describeBasisRemedy,
  describeCommonIncome,
  describeCommonSpending,
  describeMemberBalance,
  describeMemberCalendar,
  describeMissingBasis,
  describeIncomeConsumed,
  describeSplitAside,
  describeSplitBasis,
} from '@/lib/utils/expenseSplitNarrative';
import type { CommonSpending, ExpenseSplitSummary, MemberBalance, SplitBasis } from '@/lib/utils/expenseSplitSummary';
import { narrativeToText } from '@/lib/utils/narrative';
import type { Narrative } from '@/lib/utils/narrative';
import type { Period } from '@/lib/utils/period';

/**
 * it-IT puts a NO-BREAK SPACE before € and leaves four-digit amounts ungrouped, so expectations
 * are written the way the screen prints them and only the nbsp is flattened.
 */
const plain = (narrative: Narrative | null) =>
  narrative === null ? null : narrativeToText(narrative).replace(/ /g, ' ').replace(/ /g, ' ');

const AUGUST: Period = { kind: 'month', year: 2026, month: 8 };
const JULY: Period = { kind: 'month', year: 2026, month: 7 };
const NOW = new Date(2026, 7, 15, 12, 0, 0);

const NO_SCHEDULED = { expenses: 0, income: 0, count: 0, throughMonth: null };

/** The pool as `summarizeExpenseSplit` closes it: `toSplit` and `surplus` follow from the two amounts. */
function pool(overrides: Partial<CommonSpending> = {}): CommonSpending {
  const total = overrides.total ?? 1000;
  const income = overrides.income ?? 0;
  return {
    total,
    rowCount: 12,
    income,
    incomeRowCount: income > 0 ? 2 : 0,
    toSplit: Math.max(0, total - income),
    surplus: Math.max(0, income - total),
    scheduled: NO_SCHEDULED,
    ...overrides,
  };
}

/**
 * `remainingBooked` defaults to `remaining`, which is what a period with nothing in the calendar
 * looks like — the ordinary case. A fixture that wants the two apart says both out loud — and so
 * does one that SPREADS a constant (`{ ...GIUSEPPE, remaining: 834 }` carries the constant's
 * `remainingBooked: 1500` with it, so the default never applies; four cases were red on
 * 2026-09-27 for that reason, not for the code).
 */
function balance(overrides: Partial<MemberBalance> & { name: string }): MemberBalance {
  const { name, ...rest } = overrides;
  const merged: MemberBalance = {
    member: { id: `m-${name.toLowerCase()}`, name },
    income: 0,
    share: null,
    commonShare: null,
    personalSpending: 0,
    remaining: null,
    remainingBooked: null,
    ...rest,
  };
  return rest.remainingBooked === undefined ? { ...merged, remainingBooked: merged.remaining } : merged;
}

const GIUSEPPE = balance({
  name: 'Giuseppe',
  income:2400,
  share: 0.6,
  commonShare: 600,
  personalSpending: 300,
  remaining: 1500,
});

const MARCELLA = balance({
  name: 'Marcella',
  income:1600,
  share: 0.4,
  commonShare: 400,
  personalSpending: 100,
  remaining: 1100,
});

const COMPUTED_BASIS: SplitBasis = {
  kind: 'computed',
  totalIncome: 4000,
  unattributedIncome: 0,
  members: [
    { member: GIUSEPPE.member, income:2400, share: 0.6 },
    { member: MARCELLA.member, income:1600, share: 0.4 },
  ],
};

function summary(overrides: Partial<ExpenseSplitSummary> = {}): ExpenseSplitSummary {
  return {
    basis: COMPUTED_BASIS,
    common: pool(),
    members: [GIUSEPPE, MARCELLA],
    unassigned: { total: 0, rowCount: 0, income: 0, incomeRowCount: 0 },
    commonExpenses: [],
    ...overrides,
  };
}

describe('describeSplitBasis', () => {
  it('names the income each share comes from', () => {
    expect(plain(describeSplitBasis(COMPUTED_BASIS))).toBe(
      'Le quote vengono dalle entrate del periodo: Giuseppe 2400 € (60%) e Marcella 1600 € (40%).'
    );
  });

  // A percentage computed on part of the month's salaries must not be printed like one computed
  // on all of them: the spending side has always declared its orphans, the income side did not.
  it('declares the income left in comune, which the shares could not use', () => {
    expect(plain(describeSplitBasis({ ...COMPUTED_BASIS, unattributedIncome: 1100 }))).toBe(
      'Le quote vengono dalle entrate del periodo: Giuseppe 2400 € (60%) e Marcella 1600 € (40%). ' +
        'Altri 1100 € di entrate sono in comune e non entrano nelle quote.'
    );
  });
});

describe('describeMissingBasis', () => {
  it('names the person whose income is missing', () => {
    expect(
      plain(describeMissingBasis({ kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 0 }))
    ).toBe('In questo periodo non risultano entrate di Marcella: finché mancano, le quote non si calcolano.');
  });

  it('agrees in number with more than one', () => {
    expect(
      plain(
        describeMissingBasis({
          kind: 'unavailable',
          reason: 'missing-income',
          missingNames: ['Giuseppe', 'Marcella'], unattributedIncome: 0 })
      )
    ).toBe('In questo periodo non risultano entrate di Giuseppe e Marcella: finché mancano, le quote non si calcolano.');
  });

  // Income nobody is named on cannot earn a share. Declaring it is what stops a split computed
  // on part of the month's income from being printed like one computed on all of it.
  it('declares income that is attributed to nobody', () => {
    expect(
      plain(
        describeMissingBasis({ kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 1100 })
      )
    ).toContain('Altri 1100 € di entrate sono in comune e non entrano nelle quote.');
  });
});

describe('describeBasisRemedy', () => {
  // The explanation belongs to the verdict; the instruction belongs to the tile that owns the
  // absence. Each branch must name the exact screen — the one a household actually hits
  // (`missing-income`) named none until 2026-09-21.
  it('points at the screen that fixes each missing input', () => {
    expect(
      plain(describeBasisRemedy({ kind: 'unavailable', reason: 'not-enough-members', missingNames: [], unattributedIncome: 0 }))
    ).toContain('Famiglia');
    expect(
      plain(describeBasisRemedy({ kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 0 }))
    ).toBe('Registra le entrate di Marcella in Tracciamento e intestagliele.');
  });

  it('names everyone whose income is missing', () => {
    expect(
      plain(
        describeBasisRemedy({
          kind: 'unavailable',
          reason: 'missing-income',
          missingNames: ['Giuseppe', 'Marcella'],
          unattributedIncome: 0,
        })
      )
    ).toBe('Registra le entrate di Giuseppe e Marcella in Tracciamento e intestale a chi le ha ricevute.');
  });

  // The Quota tile must not reprint the verdict's own sentence: on a month with no shares the two
  // were the same 18 words, 180px apart (DESIGN.md → The One-Tile-One-Question Rule).
  it('is what the tile reads, and it is not the verdict sentence', () => {
    const basis: Extract<SplitBasis, { kind: 'unavailable' }> = {
      kind: 'unavailable',
      reason: 'missing-income',
      missingNames: ['Marcella'],
      unattributedIncome: 0,
    };
    expect(plain(describeSplitBasis(basis))).toBe(plain(describeBasisRemedy(basis)));
    expect(plain(describeSplitBasis(basis))).not.toBe(plain(describeMissingBasis(basis)));
  });
});

describe('buildSplitVerdict', () => {
  it('states the pool, each share and what is left, in the present for a running month', () => {
    const verdict = buildSplitVerdict({ summary: summary(), period: AUGUST, now: NOW });

    expect(verdict.headline).toBe('Ad agosto resta qualcosa a tutti.');
    expect(verdict.tone).toBe('positive');
    expect(plain(verdict.sentence)).toBe(
      'Ad agosto le spese in comune sono 1000 €: 600 € a Giuseppe (60%) e 400 € a Marcella (40%). ' +
        'A Giuseppe restano 1500 € dei 2400 € di entrate; a Marcella restano 1100 € dei 1600 €.'
    );
  });

  it('conjugates in the past for a closed month', () => {
    const verdict = buildSplitVerdict({ summary: summary(), period: JULY, now: NOW });

    expect(verdict.headline).toBe('A luglio è restato qualcosa a tutti.');
    expect(plain(verdict.sentence)).toContain('le spese in comune sono state 1000 €');
  });

  // The tone is the page's only claim about whether the month went well.
  it('turns negative and names who is short', () => {
    const short = balance({ ...MARCELLA, name: 'Marcella', remaining: -220, remainingBooked: -220 });
    const verdict = buildSplitVerdict({
      summary: summary({ members: [GIUSEPPE, short] }),
      period: AUGUST,
      now: NOW,
    });

    expect(verdict.headline).toBe('Ad agosto le entrate di Marcella non bastano.');
    expect(verdict.tone).toBe('negative');
    expect(plain(verdict.sentence)).toContain('a Marcella mancano 220 €');
  });

  it('says so when nobody makes it', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        members: [balance({ ...GIUSEPPE, name: 'Giuseppe', remaining: -50, remainingBooked: -50 }), balance({ ...MARCELLA, name: 'Marcella', remaining: -220, remainingBooked: -220 })],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(verdict.headline).toBe('Ad agosto le entrate non bastano a nessuno.');
  });

  // A verdict that invented 50/50 here would be putting an agreement in the couple's mouth.
  it('never guesses a share: it states the pool and names the missing input', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        basis: { kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 0 },
        members: [balance({ name: 'Giuseppe', personalSpending: 300 }), balance({ name: 'Marcella' })],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(verdict.headline).toBe('Ad agosto le quote non si possono calcolare.');
    expect(verdict.tone).toBe('neutral');
    expect(plain(verdict.sentence)).toBe(
      'Ad agosto le spese in comune sono 1000 €. In questo periodo non risultano entrate di Marcella: ' +
        'finché mancano, le quote non si calcolano.'
    );
    expect(plain(verdict.sentence)).not.toContain('%');
  });

  // The same clause Tracciamento and Analisi close on, for the same reason: the amount is INSIDE
  // the total just printed, not beside it.
  it('closes on the scheduled part of the pool, as a decomposition', () => {
    const verdict = buildSplitVerdict({
      summary: summary({ common: pool({ scheduled: { expenses: 300, income: 0, count: 1, throughMonth: null } }) }),
      period: AUGUST,
      now: NOW,
    });

    expect(plain(verdict.sentence)).toContain('Nel totale ci sono ancora 300 € di spese già in calendario');
  });

  // An empty period is not a period whose shares failed. The headline used to say «le quote non
  // si possono calcolare» over a sentence saying there was nothing to divide: two explanations of
  // one screen, the first of them sending the reader to look for data to fix.
  it('says there is nothing to divide rather than printing zeros, and the headline agrees', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        common: pool({ total: 0, rowCount: 0 }),
        members: [balance({ name: 'Giuseppe' }), balance({ name: 'Marcella' })],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(verdict.headline).toBe("Ad agosto non c'è niente da dividere.");
    expect(plain(verdict.sentence)).toBe('Ad agosto non risulta nessuna spesa, né in comune né personale.');
  });

  it('keeps the empty headline even when the basis could not be computed either', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        basis: { kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 0 },
        common: pool({ total: 0, rowCount: 0 }),
        members: [balance({ name: 'Giuseppe' }), balance({ name: 'Marcella' })],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(verdict.headline).toBe("Ad agosto non c'è niente da dividere.");
  });

  // THE POINT OF `remainingBooked`. A deficit made entirely of bills that have not been paid is
  // not a deficit: the page said «mancano 83 €» over money still in the account.
  it('judges on what has happened, then says where the calendar takes it', () => {
    const giuseppe = balance({ ...GIUSEPPE, name: 'Giuseppe', remaining: 1173, remainingBooked: 1300 });
    const tarsio = balance({
      name: 'Tarsio',
      income:1700,
      share: 0.4,
      commonShare: 803,
      personalSpending: 980,
      remaining: -83,
      remainingBooked: 0,
    });
    const verdict = buildSplitVerdict({
      summary: summary({
        members: [giuseppe, tarsio],
        common: pool({ total: 2030, rowCount: 8, scheduled: { expenses: 210, income: 0, count: 1, throughMonth: null } }),
      }),
      period: AUGUST,
      now: NOW,
    });

    // Nobody is short TODAY, so the month is not called short.
    expect(verdict.headline).toBe('Ad agosto resta qualcosa a tutti.');
    expect(verdict.tone).toBe('positive');
    expect(plain(verdict.sentence)).toContain('A Giuseppe restano 1300 € dei 2400 € di entrate; a Tarsio restano 0 € dei 1700 €.');
    expect(plain(verdict.sentence)).toContain('Con quelle, a fine periodo a Giuseppe restano 1173 € e a Tarsio mancano 83 €.');
  });

  it('adds no calendar clause when nothing is scheduled', () => {
    const verdict = buildSplitVerdict({ summary: summary(), period: AUGUST, now: NOW });
    expect(plain(verdict.sentence)).not.toContain('a fine periodo');
  });

  // Income left «in comune» pays the pool first (2026-09-27): the sentence says the gross, what
  // came off it and what was actually divided, in that order, so the shares that follow are
  // visibly shares of the NET.
  it('subtracts the common income before naming the shares, in the one sentence', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        common: pool({ total: 2410, income: 300 }),
        members: [
          balance({ ...GIUSEPPE, name: 'Giuseppe', commonShare: 1266, remaining: 834, remainingBooked: 834 }),
          balance({ ...MARCELLA, name: 'Marcella', commonShare: 844, remaining: 656, remainingBooked: 656 }),
        ],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(plain(verdict.sentence)).toBe(
      'Ad agosto le spese in comune sono 2410 €, meno 300 € di entrate in comune: 2110 € da dividere, ' +
        '1266 € a Giuseppe (60%) e 844 € a Marcella (40%). ' +
        'A Giuseppe restano 834 € dei 2400 € di entrate; a Marcella restano 656 € dei 1600 €.'
    );
  });

  // The owner's call: a surplus is declared, not handed out by the shares — so no percentage is
  // printed over a pool of zero.
  it('declares a surplus and distributes nothing', () => {
    const covered = buildSplitVerdict({
      summary: summary({
        common: pool({ total: 1000, income: 1300 }),
        members: [
          balance({ ...GIUSEPPE, name: 'Giuseppe', commonShare: 0, remaining: 2100, remainingBooked: 2100 }),
          balance({ ...MARCELLA, name: 'Marcella', commonShare: 0, remaining: 1500, remainingBooked: 1500 }),
        ],
      }),
      period: AUGUST,
      now: NOW,
    });
    expect(plain(covered.sentence)).toBe(
      "Ad agosto le spese in comune sono 1000 €, coperte per intero dai 1300 € di entrate in comune: non c'è niente da dividere, e avanzano 300 €. " +
        'A Giuseppe restano 2100 € dei 2400 € di entrate; a Marcella restano 1500 € dei 1600 €.'
    );
    expect(plain(covered.sentence)).not.toContain('%');
    expect(covered.headline).toBe('Ad agosto resta qualcosa a tutti.');

    const exact = buildSplitVerdict({
      summary: summary({ common: pool({ total: 1000, income: 1000 }) }),
      period: AUGUST,
      now: NOW,
    });
    expect(plain(exact.sentence)).toContain(
      "coperte per intero dai 1000 € di entrate in comune: non c'è niente da dividere. A Giuseppe"
    );
  });

  // The net is a fact of the window, not of the split: it is said even when the shares are not.
  it('keeps the income clause when the basis is unavailable', () => {
    const verdict = buildSplitVerdict({
      summary: summary({
        basis: { kind: 'unavailable', reason: 'missing-income', missingNames: ['Marcella'], unattributedIncome: 0 },
        common: pool({ total: 2410, income: 300 }),
        members: [balance({ name: 'Giuseppe', personalSpending: 300 }), balance({ name: 'Marcella' })],
      }),
      period: AUGUST,
      now: NOW,
    });

    expect(plain(verdict.sentence)).toBe(
      'Ad agosto le spese in comune sono 2410 €, meno 300 € di entrate in comune: 2110 € da dividere. ' +
        'In questo periodo non risultano entrate di Marcella: finché mancano, le quote non si calcolano.'
    );
  });

});

describe('describeCommonIncome', () => {
  // The email has no hero to hang the two rows on: this is the pool in one line, tense-free.
  it('says what came off the pool and what was left to divide', () => {
    expect(plain(describeCommonIncome(summary({ common: pool({ total: 2410, income: 300 }) })))).toBe(
      'Spese in comune 2410 €, meno 300 € di entrate in comune: 2110 € da dividere.'
    );
  });

  it('declares the surplus', () => {
    expect(plain(describeCommonIncome(summary({ common: pool({ total: 1000, income: 1300 }) })))).toBe(
      "Spese in comune 1000 €, coperte per intero dai 1300 € di entrate in comune: non c'è niente da dividere, e avanzano 300 €."
    );
  });

  it('is absent when no income was left in comune', () => {
    expect(describeCommonIncome(summary())).toBeNull();
  });
});

describe('describeMemberBalance', () => {
  // The sentence the whole page exists for.
  it('reads the two costs and what is left of the income', () => {
    expect(plain(describeMemberBalance(GIUSEPPE))).toBe(
      '600 € di spese in comune (il 60%), 300 € di spese personali: dai 2400 € di entrate restano 1500 €.'
    );
  });

  it('says «mancano» when the income did not cover it', () => {
    expect(plain(describeMemberBalance(balance({ ...MARCELLA, name: 'Marcella', remaining: -220, remainingBooked: -220 })))).toContain(
      'dai 1600 € di entrate mancano 220 €.'
    );
  });

  it('keeps the known half and admits the rest is unknown without a basis', () => {
    expect(plain(describeMemberBalance(balance({ name: 'Marcella', personalSpending: 120 })))).toBe(
      'Spese personali 120 €. Senza le quote non si sa quanto resta.'
    );
  });

  it('reads the BOOKED residual, not the period one', () => {
    const tarsio = balance({
      name: 'Tarsio',
      income:1700,
      share: 0.4,
      commonShare: 803,
      personalSpending: 980,
      remaining: -83,
      remainingBooked: 0,
    });
    expect(plain(describeMemberBalance(tarsio))).toContain('dai 1700 € di entrate restano 0 €.');
    expect(plain(describeMemberBalance(tarsio))).not.toContain('mancano');
  });

});

describe('describeMemberCalendar', () => {
  it('says where the rows still in the calendar take the residual', () => {
    expect(
      plain(describeMemberCalendar(balance({ name: 'Tarsio', remaining: -83, remainingBooked: 0 })))
    ).toBe('Con le spese ancora in calendario mancano 83 €.');
  });

  it('is absent when the two residuals coincide', () => {
    expect(describeMemberCalendar(GIUSEPPE)).toBeNull();
  });

  it('is absent without a basis, where there is no residual at all', () => {
    expect(describeMemberCalendar(balance({ name: 'Marcella', personalSpending: 120 }))).toBeNull();
  });
});

describe('describeCommonSpending', () => {
  it('counts the common rows', () => {
    expect(plain(describeCommonSpending(summary()))).toBe('12 voci in comune.');
  });

  it('agrees in number on a single row', () => {
    expect(
      plain(describeCommonSpending(summary({ common: pool({ total: 40, rowCount: 1 }) })))
    ).toBe('1 voce in comune.');
  });

  // Those euros are in neither the pool nor anyone's column: the reading is what keeps them from
  // simply going missing.
  it('declares the rows whose owner no longer exists', () => {
    expect(plain(describeCommonSpending(summary({ unassigned: { total: 250, rowCount: 3, income: 0, incomeRowCount: 0 } })))).toBe(
      '12 voci in comune; altre 3 per 250 € sono di qualcuno che non è più in Famiglia, e restano fuori dalla divisione.'
    );
  });

  // The income rows are counted beside the spending ones, with what they did to the pool.
  it('counts the income left in comune and says what it did to the pool', () => {
    expect(plain(describeCommonSpending(summary({ common: pool({ total: 2410, income: 300 }) })))).toBe(
      "12 voci in comune; 2 entrate in comune per 300 € riducono quel che c'è da dividere."
    );
    expect(plain(describeCommonSpending(summary({ common: pool({ total: 2410, income: 300, incomeRowCount: 1 }) })))).toBe(
      "12 voci in comune; 1 entrata in comune per 300 € riduce quel che c'è da dividere."
    );
    expect(plain(describeCommonSpending(summary({ common: pool({ total: 1000, income: 1300 }) })))).toBe(
      '12 voci in comune; 2 entrate in comune per 1300 € le coprono per intero.'
    );
  });

  // An income row whose owner has left is somebody's, so it reduces nothing — and it is said.
  // The verb follows how many rows are orphaned, across both kinds.
  it('declares the income rows whose owner no longer exists, with the spending ones', () => {
    expect(plain(describeCommonSpending(summary({ unassigned: { total: 0, rowCount: 0, income: 200, incomeRowCount: 1 } })))).toBe(
      '12 voci in comune; 1 entrata per 200 € è di qualcuno che non è più in Famiglia, e resta fuori dalla divisione.'
    );
    expect(plain(describeCommonSpending(summary({ unassigned: { total: 250, rowCount: 1, income: 0, incomeRowCount: 0 } })))).toBe(
      "12 voci in comune; un'altra per 250 € è di qualcuno che non è più in Famiglia, e resta fuori dalla divisione."
    );
    expect(plain(describeCommonSpending(summary({ unassigned: { total: 250, rowCount: 3, income: 200, incomeRowCount: 1 } })))).toBe(
      '12 voci in comune; altre 3 per 250 € e 1 entrata per 200 € sono di qualcuno che non è più in Famiglia, e restano fuori dalla divisione.'
    );
  });
});

describe('describeIncomeConsumed', () => {
  it('measures both costs against the income, article following the printed figure', () => {
    // (600 + 300) / 2400 = 37,5% → prints 38%, which takes «il».
    expect(plain(describeIncomeConsumed(GIUSEPPE))).toBe('Se ne va il 38% delle entrate.');
  });

  it('is absent without an income to measure against', () => {
    expect(describeIncomeConsumed(balance({ name: 'Marcella', commonShare: 400 }))).toBeNull();
  });
});

describe('describeSplitAside', () => {
  it('shows the split at a glance', () => {
    expect(plain(describeSplitAside(summary()))).toBe('60% · 40%');
  });

  it('is absent when there is no split to show', () => {
    expect(
      describeSplitAside(summary({ basis: { kind: 'unavailable', reason: 'missing-income', missingNames: ['x'], unattributedIncome: 0 } }))
    ).toBeNull();
  });
});
