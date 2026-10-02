/**
 * Tests for the broker TRADE import: both pure parsers, the shared numeric/date guards, and the
 * idempotent plan.
 *
 * Every fixture below is a REAL payload captured from the live brokers, not a shape invented for
 * the test. That is the whole point: these two wires are undocumented, version-drifting and the
 * fields that matter (the side, the fractional quantity, the ISIN hidden in a logo path) were each
 * found by measurement. A hand-written fixture would have kept the bug this suite exists to pin.
 */

import { describe, expect, it } from 'vitest';

import { parseBrokerDate, toFiniteNumber } from '@/lib/utils/brokerTrade';
import { parseScalableTrades } from '@/lib/utils/scalableTradeImport';
import { parseTradeRepublicTrades } from '@/lib/utils/tradeRepublicTradeImport';
import { buildBrokerTradePlan, brokerTradeKey, summarizeBrokerTradePlan } from '@/lib/utils/brokerTradePlan';

describe('toFiniteNumber', () => {
  it('reads a plain number', () => {
    expect(toFiniteNumber(11.748)).toBe(11.748);
  });

  it('reads an Italian-formatted amount (comma decimal)', () => {
    expect(toFiniteNumber('1.234,56 €')).toBe(1234.56);
  });

  it('reads an English-formatted amount (dot decimal, comma grouping)', () => {
    expect(toFiniteNumber('1,234.56')).toBe(1234.56);
  });

  it('rejects a value that is not a finite number, rather than writing NaN', () => {
    // A NaN reaching pricePerUnit makes the whole replay throw, so null is the only safe answer.
    expect(toFiniteNumber('not a number')).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
  });
});

describe('parseBrokerDate', () => {
  it('parses the Trade Republic offset with no colon, which is not strict ISO', () => {
    const parsed = parseBrokerDate('2026-10-01T08:20:17.172+0000');
    expect(parsed?.toISOString()).toBe('2026-10-01T08:20:17.172Z');
  });

  it('parses the Scalable form unchanged', () => {
    expect(parseBrokerDate('2026-09-14T10:59:35.363Z')?.toISOString()).toBe('2026-09-14T10:59:35.363Z');
  });

  it('returns null for an unparseable date, so the row is skipped instead of floored to epoch', () => {
    expect(parseBrokerDate('ieri')).toBeNull();
    expect(parseBrokerDate('')).toBeNull();
  });
});

// ─── Scalable ────────────────────────────────────────────────────────────────

/** The real sell measured live: 24 units of LU2903252349 at 11.748, 0.99 fee. */
const SCALABLE_SELL_LIST = {
  items: [
    {
      id: '5uhtwq5Fj9HfW7hC6utQ9c',
      isin: 'LU2903252349',
      description: 'Scalable MSCI AC World Xtrackers (Acc)',
      amount: 280.962,
      currency: 'EUR',
      last_event_datetime: '2026-07-29T00:00:00.000Z',
      side: 'SELL',
      status: 'SETTLED',
      type: 'SECURITY_TRANSACTION',
    },
    {
      id: 'CASH_7tqK1YA6BnX3dKJrLiukfU_8DBKDFIQUQ49APC1Y5LRBG',
      amount: 5000,
      currency: 'EUR',
      description: 'Trasferimento interno',
      last_event_datetime: '2026-09-07T00:00:00.000Z',
      cash_transaction_type: 'CASH_TRANSFER_IN',
      status: 'SETTLED',
      type: 'CASH_TRANSACTION',
    },
  ],
};

const SCALABLE_SELL_DETAIL = {
  id: '5uhtwq5Fj9HfW7hC6utQ9c',
  security: { isin: 'LU2903252349', name: 'Scalable MSCI AC World Xtrackers (Acc)', security_type: 'ETF' },
  security_trade: {
    average_price: 11.748,
    number_of_shares: { filled: 24, total: 24 },
    total_amount: 280.962,
    side: 'SELL',
    status: 'FINAL_FILL',
    trade_transaction_amounts: { market_valuation: 281.952, transaction_fee: 0.99, tax_amount: null, venue_fee: null },
  },
};

describe('parseScalableTrades', () => {
  it('maps a measured sell onto a BrokerTrade', () => {
    const { trades } = parseScalableTrades(
      SCALABLE_SELL_LIST,
      new Map([['5uhtwq5Fj9HfW7hC6utQ9c', SCALABLE_SELL_DETAIL]])
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      source: 'scalable',
      sourceRef: '5uhtwq5Fj9HfW7hC6utQ9c',
      type: 'sell',
      isin: 'LU2903252349',
      quantity: 24,
      pricePerUnit: 11.748,
      currency: 'EUR',
      fees: 0.99,
    });
  });

  it('never writes a CASH_TRANSACTION, and says why', () => {
    const { trades, skipped } = parseScalableTrades(
      SCALABLE_SELL_LIST,
      new Map([['5uhtwq5Fj9HfW7hC6utQ9c', SCALABLE_SELL_DETAIL]])
    );
    expect(trades.map((trade) => trade.sourceRef)).not.toContain('CASH_7tqK1YA6BnX3dKJrLiukfU_8DBKDFIQUQ49APC1Y5LRBG');
    expect(skipped.some((row) => row.reason.includes('cassa'))).toBe(true);
  });

  it('refuses a security trade whose detail never arrived, rather than using the cash amount', () => {
    // The list row amount is the PROCEEDS. Importing it as a unit price would invent a price of
    // 280.962 for a 24-unit position and blow the realized gain up by three orders of magnitude.
    const { trades, skipped } = parseScalableTrades(SCALABLE_SELL_LIST, new Map());
    expect(trades).toHaveLength(0);
    expect(skipped.find((row) => row.sourceRef === '5uhtwq5Fj9HfW7hC6utQ9c')?.reason).toContain('Dettaglio');
  });

  it('refuses an unsettled trade: a pending order is an intention, not a fact', () => {
    const { trades, skipped } = parseScalableTrades(
      { items: [{ ...SCALABLE_SELL_LIST.items[0], status: 'PENDING' }] },
      new Map([['5uhtwq5Fj9HfW7hC6utQ9c', SCALABLE_SELL_DETAIL]])
    );
    expect(trades).toHaveLength(0);
    expect(skipped[0].reason).toContain('non regolata');
  });

  it('adds transaction_fee and venue_fee, because both debit the buyer', () => {
    const detail = {
      ...SCALABLE_SELL_DETAIL,
      security_trade: {
        ...SCALABLE_SELL_DETAIL.security_trade,
        trade_transaction_amounts: { transaction_fee: 0.99, venue_fee: 0.11, tax_amount: null },
      },
    };
    const { trades } = parseScalableTrades(SCALABLE_SELL_LIST, new Map([['5uhtwq5Fj9HfW7hC6utQ9c', detail]]));
    expect(trades[0].fees).toBe(1.1);
  });

  it('reads a filled savings plan as a buy with its fractional quantity', () => {
    const { trades } = parseScalableTrades(
      {
        items: [
          {
            id: 'q9Yc4BSHp85cafCe2jRpKD',
            isin: 'IE00BD4TXV59',
            description: 'UBS Core MSCI World (Acc)',
            amount: -5000,
            currency: 'EUR',
            last_event_datetime: '2026-09-14T10:33:06.128Z',
            security_transaction_type: 'SAVINGS_PLAN',
            side: 'BUY',
            status: 'SETTLED',
            type: 'SECURITY_TRANSACTION',
          },
        ],
      },
      new Map([
        [
          'q9Yc4BSHp85cafCe2jRpKD',
          {
            id: 'q9Yc4BSHp85cafCe2jRpKD',
            security: { isin: 'IE00BD4TXV59', name: 'UBS Core MSCI World (Acc)' },
            security_trade: {
              average_price: 10.93,
              number_of_shares: { filled: 127.255605, total: 127.255605 },
              order_kind: 'SAVINGS_PLAN',
              side: 'BUY',
              status: 'FINAL_FILL',
              trade_transaction_amounts: { transaction_fee: 0, tax_amount: null, venue_fee: null },
            },
          },
        ],
      ])
    );
    expect(trades[0]).toMatchObject({ type: 'buy', isin: 'IE00BD4TXV59', quantity: 127.255605, pricePerUnit: 10.93 });
  });
});

// ─── Trade Republic ──────────────────────────────────────────────────────────

/** The real Micron sell, measured live. The side is in the subtitle, the ISIN in the logo path. */
const TR_SELL_ROW = {
  id: '7da576c8-1583-41c5-90c9-63f91048767f',
  timestamp: '2026-10-01T08:20:17.172+0000',
  title: 'Micron Technology',
  icon: 'logos/US5951121038/v2',
  avatar: { asset: 'logos/US5951121038/v2', badge: null },
  badge: null,
  subtitle: 'Sell Order',
  amount: { currency: 'EUR', value: 3790.29, fractionDigits: 2 },
  subAmount: null,
  status: 'EXECUTED',
  action: { type: 'timelineDetail', payload: '7da576c8-1583-41c5-90c9-63f91048767f' },
  cashAccountNumber: '0479974411',
  hidden: false,
  deleted: false,
  eventType: 'TRADING_TRADE_EXECUTED',
};

const TR_SELL_DETAIL = {
  id: '7da576c8-1583-41c5-90c9-63f91048767f',
  sections: [
    {
      title: 'You received €3,790.29',
      data: { icon: { asset: 'logos/US5951121038/v2', badge: null }, subtitleText: '1 Oct · 8:20 AM', status: 'executed' },
      action: { payload: 'US5951121038', type: 'instrumentDetail' },
      type: 'header',
    },
    {
      title: 'Overview',
      data: [
        { title: 'Sell', detail: { text: 'Executed', functionalStyle: 'EXECUTED', type: 'status' }, style: 'plain' },
        { title: 'Asset', detail: { text: 'Micron Technology', type: 'text' }, style: 'plain' },
        {
          title: 'Transaction',
          detail: {
            text: '4.027288 ×  €941.40',
            displayValue: { text: '€941.40', prefix: '4.027288 × ', textDataSensitivity: 'PUBLIC' },
            type: 'text',
          },
          style: 'plain',
        },
        { title: 'Fee', detail: { text: '€1.00' }, style: 'plain' },
        { title: 'Total', detail: { text: '€3,790.29' }, style: 'plain' },
      ],
      type: 'table',
    },
  ],
};

describe('parseTradeRepublicTrades', () => {
  it('maps the measured sell, taking the side from the subtitle and the ISIN from the logo path', () => {
    const { trades } = parseTradeRepublicTrades({ items: [TR_SELL_ROW] }, new Map([[TR_SELL_ROW.id, TR_SELL_DETAIL]]));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      source: 'traderepublic',
      sourceRef: TR_SELL_ROW.id,
      type: 'sell',
      isin: 'US5951121038',
      quantity: 4.027288,
      pricePerUnit: 941.4,
      currency: 'EUR',
      fees: 1,
    });
  });

  it('never reads a card transaction, an interest payout or a deposit as a trade', () => {
    const { trades } = parseTradeRepublicTrades(
      {
        items: [
          { ...TR_SELL_ROW, eventType: 'CARD_TRANSACTION', subtitle: null, title: 'ATA BATTISTI XPAY' },
          { ...TR_SELL_ROW, id: 'b1', eventType: 'INTEREST_PAYOUT', subtitle: null, title: 'Interest' },
          { ...TR_SELL_ROW, id: 'p1', eventType: 'PAYMENT_INBOUND', subtitle: null, title: 'Riccardo Maistri' },
        ],
      },
      new Map()
    );
    expect(trades).toHaveLength(0);
  });

  it('keeps a failed savings plan out of the ledger: it has no shares and never will', () => {
    const { trades, skipped } = parseTradeRepublicTrades(
      { items: [{ ...TR_SELL_ROW, eventType: 'SAVINGS_PLAN_EXECUTION_FAILED', subtitle: 'Savings Plan' }] },
      new Map()
    );
    expect(trades).toHaveLength(0);
    expect(skipped[0].reason).toContain('non eseguito');
  });

  it('refuses a row whose cash moves against its stated side', () => {
    const { trades, skipped } = parseTradeRepublicTrades(
      { items: [{ ...TR_SELL_ROW, amount: { currency: 'EUR', value: -3790.29, fractionDigits: 2 } }] },
      new Map([[TR_SELL_ROW.id, TR_SELL_DETAIL]])
    );
    expect(trades).toHaveLength(0);
    expect(skipped[0].reason).toContain('discordanti');
  });

  it('refuses a trade whose detail never arrived, rather than treating the proceeds as a price', () => {
    const { trades, skipped } = parseTradeRepublicTrades({ items: [TR_SELL_ROW] }, new Map());
    expect(trades).toHaveLength(0);
    expect(skipped[0].reason).toContain('Dettaglio');
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('buildBrokerTradePlan', () => {
  const assets = [{ id: 'a1', isin: 'US5951121038', name: 'Micron Technology', type: 'etf' as const }];
  const trade = parseTradeRepublicTrades({ items: [TR_SELL_ROW] }, new Map([[TR_SELL_ROW.id, TR_SELL_DETAIL]])).trades[0];

  it('classifies a known trade on a known asset as importable', () => {
    const plan = buildBrokerTradePlan({ trades: [trade], assets, existingTransactions: [] });
    expect(plan.toImport).toHaveLength(1);
    expect(plan.toImport[0].assetId).toBe('a1');
  });

  it('is idempotent: a second run over the same trade imports nothing', () => {
    // This is the assertion that matters most. Without sourceRef the second run would double the
    // position, halve the PMC and halve every realized gain from here on.
    const existing = [{ source: 'traderepublic' as const, sourceRef: TR_SELL_ROW.id }];
    const plan = buildBrokerTradePlan({ trades: [trade], assets, existingTransactions: existing });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.alreadyImported).toHaveLength(1);
  });

  it('does not match a same-id trade from the OTHER broker', () => {
    // Broker ids are per-broker. Sharing a key would let Scalable's row suppress TR's.
    const existing = [{ source: 'scalable' as const, sourceRef: TR_SELL_ROW.id }];
    expect(buildBrokerTradePlan({ trades: [trade], assets, existingTransactions: existing }).toImport).toHaveLength(1);
  });

  it('skips a trade whose instrument is not in Portafoglio, and never creates it', () => {
    const plan = buildBrokerTradePlan({ trades: [trade], assets: [], existingTransactions: [] });
    expect(plan.skipped[0].reason).toBe('asset-not-found');
    expect(plan.toImport).toHaveLength(0);
  });

  it('skips a trade on a non-ledger asset, whose quantity the replay does not own', () => {
    const plan = buildBrokerTradePlan({
      trades: [trade],
      assets: [{ id: 'c1', isin: 'US5951121038', name: 'Conti corrente', type: 'cash' }],
      existingTransactions: [],
    });
    expect(plan.skipped[0].reason).toBe('asset-not-ledger');
  });

  it('skips a trade dated before the asset baseline, because the cost basis cannot be rebuilt', () => {
    // The measured sell is 2026-10-01, so the baseline has to be LATER for the trade to precede it:
    // a baseline is the opening position, and nothing may come before it (BASELINE_NOT_FIRST).
    const plan = buildBrokerTradePlan({
      trades: [trade],
      assets,
      existingTransactions: [],
      baselineByAssetId: new Map([['a1', new Date('2026-11-01T00:00:00Z')]]),
    });
    expect(plan.skipped[0].reason).toBe('before-baseline');
  });

  it('accepts any past date for an asset that has no baseline of its own', () => {
    // Since 2026-09-13 the asset's OWN baseline is the only floor a date has; the migration-wide
    // `assetTransactionsMeta.baselineDate` is not one, and must not be mistaken for it here.
    const plan = buildBrokerTradePlan({ trades: [trade], assets, existingTransactions: [] });
    expect(plan.toImport).toHaveLength(1);
  });

  it('summarizes an unchanged sync as nothing to do', () => {
    const existing = [{ source: 'traderepublic' as const, sourceRef: TR_SELL_ROW.id }];
    const plan = buildBrokerTradePlan({ trades: [trade], assets, existingTransactions: existing });
    expect(summarizeBrokerTradePlan(plan)).toContain('nessuna nuova');
  });

  it('builds the key the ledger row stores', () => {
    expect(brokerTradeKey('scalable', 'abc')).toBe('scalable:abc');
  });
});
