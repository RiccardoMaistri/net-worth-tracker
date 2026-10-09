/**
 * «Le vendite del broker che il registro non ha» — the pure layer, and the completeness reading the
 * Plusvalenze detail declares.
 *
 * Two rules shape every case here, and both are the ones a fixture makes invisible:
 *
 *  1. **A BROKER SELL IS NOT A REALIZED GAIN.** It has no cost basis until the ledger replays it, so
 *     no row here has a gain, a percentage or a cost cell, and the totals are the broker's CASH
 *     (`lordo − fee − tassa`), never a profit. A `Gain`/`Profit` cell in the payload is what the
 *     ledger computes, not what the broker prints.
 *  2. **A BUY IS NEVER LISTED.** It realizes nothing; a savings-plan buy is not a missing sale and
 *     counting it would inflate the number this section exists to state.
 *
 * The year is Italian (`getItalyYear`), so a 31 December evening sale does not land in the next
 * fiscal year the way `getFullYear` would put it under `TZ=UTC`.
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeUnbookedBrokerSells,
  sumUnbookedSells,
} from '@/lib/utils/unbookedBrokerSells';
import {
  describeUnbookedSell,
  describeUnbookedSells,
} from '@/lib/utils/unbookedSellsNarrative';
import { narrativeToText, type Narrative } from '@/lib/utils/narrative';
import type { BrokerTrade } from '@/lib/utils/brokerTrade';
import type { BrokerTradeRow, BrokerTradeSkip } from '@/lib/utils/brokerTradePlan';

const flat = (text: string) => text.replace(/[  ]/g, ' ');
const plain = (n: Narrative | null) => (n ? flat(narrativeToText(n)) : null);

function trade(over: Partial<BrokerTrade> = {}): BrokerTrade {
  return {
    sourceRef: 'tr-1',
    source: 'traderepublic',
    type: 'sell',
    label: 'Micron Technology',
    date: new Date(2026, 9, 1, 12),
    quantity: 4.027288,
    pricePerUnit: 941.4,
    currency: 'EUR',
    fees: 1,
    withheldTax: 86.67,
    ...over,
  };
}

function row(over: Partial<BrokerTrade> = {}, assetId?: string): BrokerTradeRow {
  return { trade: trade(over), status: 'new', ...(assetId ? { assetId } : {}) };
}

function skip(over: Partial<BrokerTrade>, reason: BrokerTradeSkip['reason']): BrokerTradeSkip {
  return { trade: trade(over), reason, message: 'messaggio del piano' };
}

describe('summarizeUnbookedBrokerSells', () => {
  it('lists the year’s sells the ledger does not hold, oldest first, with the reason', () => {
    const sells = summarizeUnbookedBrokerSells(
      [
        row({ sourceRef: 'later', date: new Date(2026, 8, 29, 12) }, 'a1'),
        row({ sourceRef: 'earlier', date: new Date(2026, 2, 14, 12) }, 'a1'),
      ],
      [],
      2026
    );

    expect(sells.map((s) => s.sourceRef)).toEqual(['earlier', 'later']);
    expect(sells[0].reasonKey).toBe('not-imported');
    expect(sells[0].assetId).toBe('a1');
    // The broker's own figures travel through; nothing is recomputed here.
    expect(sells[0]).toMatchObject({ quantity: 4.027288, pricePerUnit: 941.4, fees: 1, withheldTax: 86.67 });
  });

  it('never lists a buy: it realizes nothing, and this section is about realizations', () => {
    const sells = summarizeUnbookedBrokerSells(
      [row({ type: 'buy', sourceRef: 'b1' }), row({ sourceRef: 's1' })],
      [],
      2026
    );
    expect(sells.map((s) => s.sourceRef)).toEqual(['s1']);
  });

  it('counts a sell the ledger REFUSED for its own reason, and names that reason', () => {
    // The four reasons are different problems: «importala tu» vs «manca lo strumento» vs «manca
    // l'ISIN» vs «la base di costo non esiste». One sentence for all four would be a wrong fix.
    const sells = summarizeUnbookedBrokerSells(
      [],
      [
        skip({ sourceRef: 's1' }, 'asset-not-found'),
        skip({ sourceRef: 's2' }, 'no-isin'),
        skip({ sourceRef: 's3' }, 'before-baseline'),
        skip({ sourceRef: 's4' }, 'asset-not-ledger'),
      ],
      2026
    );

    expect(sells.map((s) => s.reasonKey)).toEqual([
      'asset-not-found',
      'no-isin',
      'before-baseline',
      'not-ledger',
    ]);
    expect(sells.every((s) => !s.assetId)).toBe(true);
  });

  it('buckets by ITALIAN year, so a 31 December evening sale is not next year', () => {
    // 23:30 Rome on 31/12/2026 → 2026 under `TZ=UTC` this would be 2026 only by luck; the
    // guard that matters is the morning one, 00:30 Rome on 01/01/2027 → 2027, never 2026.
    const sells = summarizeUnbookedBrokerSells(
      [
        row({ sourceRef: 'ny-eve', date: new Date('2026-12-31T22:30:00Z') }),
        row({ sourceRef: 'ny-day', date: new Date('2026-12-31T23:30:00Z') }),
      ],
      [],
      2026
    );
    expect(sells.map((s) => s.sourceRef)).toEqual(['ny-eve']);
  });

  it('returns nothing for a year the broker has no sells in', () => {
    expect(summarizeUnbookedBrokerSells([row({ date: new Date(2025, 5, 1, 12) })], [], 2026)).toEqual([]);
  });
});

describe('sumUnbookedSells', () => {
  // The measured Micron sale of 2026-10-01: `lordo − fee − tassa` is what the broker paid out.
  it('totals what the broker PAID OUT, never a gain', () => {
    const totals = sumUnbookedSells(
      summarizeUnbookedBrokerSells(
        [
          row({ sourceRef: 's1', quantity: 4.027288, pricePerUnit: 941.4, fees: 1, withheldTax: 86.67 }),
          row({
            sourceRef: 's2',
            date: new Date(2026, 5, 18, 12),
            quantity: 0.318755,
            pricePerUnit: 996.1,
            fees: 1,
            withheldTax: 16.76,
          }),
        ],
        [],
        2026
      )
    );

    // 3791,29 + 317,51 lordo; − 2 € di commissioni; − 103,43 € di tassa trattenuta.
    expect(totals.grossEur).toBeCloseTo(4108.8, 2);
    expect(totals.feesEur).toBe(2);
    expect(totals.withheldTaxEur).toBeCloseTo(103.43, 2);
    expect(totals.netEur).toBeCloseTo(4003.37, 2);
  });

  it('leaves the tax at zero when the broker reported none, rather than estimating one', () => {
    const totals = sumUnbookedSells(
      summarizeUnbookedBrokerSells(
        [row({ quantity: 10, pricePerUnit: 110, fees: undefined, withheldTax: undefined })],
        [],
        2026
      )
    );
    expect(totals.withheldTaxEur).toBe(0);
    expect(totals.netEur).toBe(1100);
  });
});

describe('describeUnbookedSell', () => {
  it('gives each reason its own words', () => {
    const labels = (['not-imported', 'asset-not-found', 'no-isin', 'before-baseline', 'not-ledger'] as const).map(
      describeUnbookedSell
    );
    // A label that is a prefix of another would be read as the wrong one.
    expect(new Set(labels).size).toBe(labels.length);
    expect(describeUnbookedSell('not-imported')).toBe('Non ancora nel registro');
  });
});

describe('describeUnbookedSells', () => {
  const ready = (sells: ReturnType<typeof summarizeUnbookedBrokerSells>, brokerSellCount: number) => ({
    state: 'ready' as const,
    sells,
    totals: sumUnbookedSells(sells),
    brokerSellCount,
  });

  it('counts the missing rows against the broker’s whole year, so the number is a completeness claim', () => {
    const sells = summarizeUnbookedBrokerSells([row({ quantity: 1, pricePerUnit: 100, fees: undefined, withheldTax: undefined })], [], 2026);
    expect(plain(describeUnbookedSells(ready(sells, 10), 2026))).toBe(
      'Nel 2026 Trade Republic ha registrato 10 vendite: 1 non è ancora nel registro, per ricavi di 100,00 €.'
    );
  });

  it('says nothing is missing when the ledger holds them all, without claiming the broker is complete', () => {
    expect(plain(describeUnbookedSells(ready([], 10), 2026))).toBe(
      'Nel 2026 Trade Republic ha registrato 10 vendite: sono tutte nel registro.'
    );
  });

  it('drops the money clause when no row is importable: a total beside an unfixable row is a promise', () => {
    const sells = summarizeUnbookedBrokerSells([], [skip({ sourceRef: 's1' }, 'asset-not-found')], 2026);
    expect(plain(describeUnbookedSells(ready(sells, 1), 2026))).toBe(
      'Nel 2026 Trade Republic ha registrato 1 vendita: 1 non è ancora nel registro, e nessuna è importabile finché lo strumento non è tracciato.'
    );
  });

  // A failed read is NOT an empty list: three states, three different sentences, and none of them
  // may be the «all in the ledger» one.
  it('separates not-linked, expired and failed, and never claims completeness', () => {
    const empty = {
      sells: [],
      totals: {
        grossEur: 0,
        feesEur: 0,
        withheldTaxEur: 0,
        netEur: 0,
        brokerGainEur: 0,
        brokerCostBasisEur: 0,
        brokerGainRowCount: 0,
      },
      brokerSellCount: 0,
    };
    expect(plain(describeUnbookedSells({ ...empty, state: 'not-linked' }, 2026))).toContain('non è collegato');
    expect(plain(describeUnbookedSells({ ...empty, state: 'session-expired' }, 2026))).toContain('scaduta');
    expect(plain(describeUnbookedSells({ ...empty, state: 'failed' }, 2026))).toContain('non si sono potute leggere');
  });
});