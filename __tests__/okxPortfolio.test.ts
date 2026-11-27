import { describe, expect, it } from 'vitest';
import {
  buildOkxPortfolio,
  OkxParseError,
  parseOkxBalance,
  parseOkxFundingBalances,
  parseOkxPositions,
  parseOkxSavingsBalances,
  parseOkxStakingOrders,
  parseOkxTickers,
  resolveOkxUsdPrice,
} from '@/lib/utils/okxPortfolio';

const balance = {
  code: '0',
  data: [
    {
      totalEq: '10811.111111',
      details: [
        {
          ccy: 'BTC',
          cashBal: '0.1',
          spotBal: '0.1',
          eqUsd: '6500',
          openAvgPx: '60000',
          spotUpl: '500',
          spotUplRatio: '0.0833',
          accAvgPx: '59000',
          totalPnl: '600',
          totalPnlRatio: '0.1',
        },
        {
          ccy: 'USDT',
          cashBal: '3000',
          spotBal: '',
          eqUsd: '3000',
          openAvgPx: '',
          spotUpl: '',
          spotUplRatio: '',
          accAvgPx: '',
          totalPnl: '',
          totalPnlRatio: '',
        },
        {
          ccy: 'EUR',
          cashBal: '0',
          spotBal: '',
          eqUsd: '0',
          openAvgPx: '',
          spotUpl: '',
          spotUplRatio: '',
          accAvgPx: '',
          totalPnl: '',
          totalPnlRatio: '',
        },
      ],
    },
  ],
};

const funding = [
  { ccy: 'BTC', bal: '0.02', availBal: '0.02' },
  { ccy: 'DOGE', bal: '100', availBal: '100' },
  { ccy: 'XRP', bal: '0', availBal: '0' },
];

const savings = [
  { ccy: 'BTC', amt: '0.5', loanAmt: '0.5', pendingAmt: '0' },
  { ccy: 'XRP', amt: '100', loanAmt: '100', pendingAmt: '0' },
  { ccy: 'DOGE', amt: '0', loanAmt: '0', pendingAmt: '0' },
];

const staking = [
  {
    ordId: '10467071',
    ccy: 'TRX',
    protocol: 'On-Chain Defi',
    protocolType: 'defi',
    state: '1',
    apy: '0.0309',
    investData: [{ ccy: 'TRX', amt: '954.522039' }],
    earningData: [{ ccy: 'TRX', earnings: '0.16065194' }],
  },
];

const positions = [
  {
    instId: 'ETH-USDT-SWAP',
    instType: 'SWAP',
    posSide: 'long',
    pos: '2',
    avgPx: '3000',
    markPx: '3100',
    notionalUsd: '6200',
    upl: '200',
    uplRatio: '0.033',
    lever: '3',
    mgnMode: 'cross',
  },
];

describe('parseOkxBalance', () => {
  it('reads the coin quantity, OKX equity and BOTH cost methods', () => {
    const snapshot = parseOkxBalance(balance);
    expect(snapshot.totalEquityUsd).toBeCloseTo(10811.111111);
    expect(snapshot.details).toHaveLength(3);

    const btc = snapshot.details[0];
    expect(btc).toMatchObject({
      ccy: 'BTC',
      quantity: 0.1,
      spotBalance: 0.1,
      equityUsd: 6500,
      averageCostPriceUsd: 60000,
      averageCostPnlUsd: 500,
      averageCostPnlRatio: 0.0833,
      cumulativeCostPriceUsd: 59000,
      cumulativeCostPnlUsd: 600,
      cumulativeCostPnlRatio: 0.1,
    });

    // Stablecoins and fiat are excluded from the spot cost price: "" is «not applicable».
    expect(snapshot.details[1]).toMatchObject({
      ccy: 'USDT',
      quantity: 3000,
      averageCostPriceUsd: null,
      averageCostPnlUsd: null,
      cumulativeCostPnlUsd: null,
    });
  });

  it('refuses a payload without details instead of reading an empty account', () => {
    expect(() => parseOkxBalance({ data: [{ totalEq: '1' }] })).toThrow(OkxParseError);
    expect(() => parseOkxBalance(null)).toThrow(OkxParseError);
  });

  it('falls back to the spot net buying amount when the cash balance is empty', () => {
    const snapshot = parseOkxBalance({
      data: [{ details: [{ ccy: 'SOL', cashBal: '', spotBal: '4', eqUsd: '640' }] }],
    });
    expect(snapshot.details[0]?.quantity).toBe(4);
  });
});

describe('parseOkxFundingBalances', () => {
  it('keeps positive balances and drops zeros', () => {
    expect(parseOkxFundingBalances(funding)).toEqual([
      { ccy: 'BTC', quantity: 0.02, available: 0.02 },
      { ccy: 'DOGE', quantity: 100, available: 100 },
    ]);
  });
});

describe('parseOkxSavingsBalances', () => {
  it('keeps the position, names the lent part and drops a zero row', () => {
    expect(parseOkxSavingsBalances(savings)).toEqual([
      { ccy: 'BTC', amount: 0.5, loanAmount: 0.5, pendingAmount: 0 },
      { ccy: 'XRP', amount: 100, loanAmount: 100, pendingAmount: 0 },
    ]);
  });
});

describe('parseOkxStakingOrders', () => {
  it('reads the principal and the earnings apart, never summed', () => {
    const [order] = parseOkxStakingOrders(staking);
    expect(order).toMatchObject({ ccy: 'TRX', principal: 954.522039, earnings: 0.16065194 });
  });

  it('drops an order with no principal', () => {
    expect(parseOkxStakingOrders([{ ccy: 'ADA', investData: [], earningData: [] }])).toEqual([]);
  });
});

describe('parseOkxPositions', () => {
  it('reads the contracts and OKX’s own unrealized P&L', () => {
    expect(parseOkxPositions(positions)).toEqual([
      {
        instId: 'ETH-USDT-SWAP',
        instType: 'SWAP',
        posSide: 'long',
        quantity: 2,
        averagePrice: 3000,
        markPrice: 3100,
        notionalUsd: 6200,
        unrealizedPnlUsd: 200,
        unrealizedPnlRatio: 0.033,
        leverage: 3,
        marginMode: 'cross',
      },
    ]);
  });
});

describe('parseOkxTickers', () => {
  it('keeps a usable last price only', () => {
    expect(parseOkxTickers([{ instId: 'BTC-USDT', last: '65000' }, { instId: 'ZERO-USDT', last: '0' }])).toEqual({
      'BTC-USDT': 65000,
    });
  });
});

describe('resolveOkxUsdPrice', () => {
  const prices = { 'BTC-USDT': 65000, 'ETH-EUR': 2700 };
  it('prefers the USDT pair', () => {
    expect(resolveOkxUsdPrice('BTC', prices, 0.9)).toBe(65000);
  });
  it('converts an EUR pair through the USD→EUR rate', () => {
    expect(resolveOkxUsdPrice('ETH', prices, 0.9)).toBeCloseTo(3000);
  });
  it('prices a stablecoin at 1 USD, an EUR balance at the FX rate, and an unknown coin at null', () => {
    expect(resolveOkxUsdPrice('USDT', {}, 0.9)).toBe(1);
    expect(resolveOkxUsdPrice('EUR', {}, 0.9)).toBeCloseTo(1 / 0.9);
    expect(resolveOkxUsdPrice('EUR', {}, null)).toBeNull();
    expect(resolveOkxUsdPrice('NOPE', {}, 0.9)).toBeNull();
    // An EUR pair with no FX rate is not priced: a guessed euro is worse than an absent figure.
    expect(resolveOkxUsdPrice('ETH', prices, null)).toBeNull();
  });
});

describe('buildOkxPortfolio', () => {
  const build = () =>
    buildOkxPortfolio({
      balance: parseOkxBalance(balance),
      funding: parseOkxFundingBalances(funding),
      savings: [],
      staking: [],
      positions: parseOkxPositions(positions),
      tickers: parseOkxTickers([{ instId: 'BTC-USDT', last: '65000' }, { instId: 'DOGE-EUR', last: '0.1' }]),
      usdEur: 0.9,
    });

  it('merges the wallets per coin, keeps the wallets that hold it and prices both', () => {
    const portfolio = build();
    const btc = portfolio.holdings.find((holding) => holding.ccy === 'BTC');
    expect(btc?.quantity).toBeCloseTo(0.12);
    expect(btc).toMatchObject({
      quantityTrading: 0.1,
      quantityFunding: 0.02,
      wallets: ['trading', 'funding'],
      valueUsd: 7800,
      valueEur: 7020,
      priceUsd: 65000,
      averageCostPriceUsd: 60000,
      unrealizedPnlUsd: 500,
      unrealizedPnlEur: 450,
      unrealizedPnlRatio: 0.0833,
      cumulativeCostPnlUsd: 600,
      costPriceExcluded: false,
    });
  });

  it('prices a funding-only coin from its ticker and keeps the cumulative P&L apart', () => {
    const portfolio = build();
    const doge = portfolio.holdings.find((holding) => holding.ccy === 'DOGE');
    expect(doge?.quantity).toBe(100);
    expect(doge?.wallets).toEqual(['funding']);
    expect(doge?.valueUsd).toBeCloseTo(100 / 9);
    expect(doge?.unrealizedPnlUsd).toBeNull();
    // The two cost methods price the same holding: their P&L is never added together.
    expect(portfolio.holdings.find((holding) => holding.ccy === 'BTC')?.cumulativeCostPnlUsd).toBe(600);
    expect(portfolio.totals.unrealizedPnlUsd).toBe(500);
  });

  it('totals the wallets, the P&L and the derivatives apart', () => {
    const portfolio = build();
    expect(portfolio.totals.tradingValueUsd).toBe(9500);
    expect(portfolio.totals.fundingValueUsd).toBeCloseTo(1300 + 100 / 9);
    expect(portfolio.totals.holdingsValueUsd).toBeCloseTo(9500 + 1300 + 100 / 9);
    expect(portfolio.totals.holdingsValueEur).toBeCloseTo((9500 + 1300 + 100 / 9) * 0.9);
    expect(portfolio.totals.unrealizedPnlUsd).toBe(500);
    expect(portfolio.totals.unrealizedPnlEur).toBe(450);
    expect(portfolio.totals.derivativesNotionalUsd).toBe(6200);
    expect(portfolio.totals.derivativesUnrealizedPnlUsd).toBe(200);
    expect(portfolio.totals.accountEquityUsd).toBeCloseTo(10811.111111);
  });

  it('values a funding euro at one euro: its USD price is the FX rate, never 1 USD', () => {
    const portfolio = buildOkxPortfolio({
      balance: { details: [], totalEquityUsd: null },
      funding: [{ ccy: 'EUR', quantity: 10, available: 10 }],
      savings: [],
      staking: [],
      positions: [],
      tickers: {},
      usdEur: 0.9,
    });
    expect(portfolio.holdings[0]?.valueUsd).toBeCloseTo(10 / 0.9);
    expect(portfolio.holdings[0]?.valueEur).toBeCloseTo(10);
  });

  it('keeps the priced wallet when the other one has no price, and names the coin', () => {
    const portfolio = buildOkxPortfolio({
      balance: {
        details: [
          {
            ccy: 'XRP',
            quantity: 10,
            spotBalance: 10,
            equityUsd: 10,
            averageCostPriceUsd: null,
            averageCostPnlUsd: null,
            averageCostPnlRatio: null,
            cumulativeCostPriceUsd: null,
            cumulativeCostPnlUsd: null,
            cumulativeCostPnlRatio: null,
          },
        ],
        totalEquityUsd: 10,
      },
      funding: [{ ccy: 'XRP', quantity: 5, available: 5 }],
      savings: [],
      staking: [],
      positions: [],
      tickers: {},
      usdEur: 0.9,
    });
    expect(portfolio.holdings[0]).toMatchObject({ ccy: 'XRP', valueUsd: 10, valueEur: 9 });
    expect(portfolio.totals.unpriced).toEqual(['XRP']);
    expect(portfolio.totals.fundingValueUsd).toBe(0);
  });

  it('names a coin no ticker reaches instead of valuing it at zero', () => {    const portfolio = buildOkxPortfolio({
      balance: { details: [], totalEquityUsd: null },
      funding: [{ ccy: 'NOPE', quantity: 5, available: 5 }],
      savings: [],
      staking: [],
      positions: [],
      tickers: {},
      usdEur: 0.9,
    });
    expect(portfolio.holdings[0]).toMatchObject({ ccy: 'NOPE', valueUsd: null, valueEur: null });
    expect(portfolio.totals.unpriced).toEqual(['NOPE']);
    expect(portfolio.warnings.join(' ')).toContain('NOPE');
  });

  it('does not count an absent spot P&L as zero, and does not flag a stablecoin', () => {
    const portfolio = buildOkxPortfolio({
      balance: {
        details: [
          {
            ccy: 'XRP',
            quantity: 10,
            spotBalance: 10,
            equityUsd: 10,
            averageCostPriceUsd: null,
            averageCostPnlUsd: null,
            averageCostPnlRatio: null,
            cumulativeCostPriceUsd: null,
            cumulativeCostPnlUsd: null,
            cumulativeCostPnlRatio: null,
          },
          {
            ccy: 'USDT',
            quantity: 50,
            spotBalance: null,
            equityUsd: 50,
            averageCostPriceUsd: null,
            averageCostPnlUsd: null,
            averageCostPnlRatio: null,
            cumulativeCostPriceUsd: null,
            cumulativeCostPnlUsd: null,
            cumulativeCostPnlRatio: null,
          },
        ],
        totalEquityUsd: 60,
      },
      funding: [],
      savings: [],
      staking: [],
      positions: [],
      tickers: { 'XRP-USDT': 1 },
      usdEur: 1,
    });
    expect(portfolio.totals.pnlUnavailable).toEqual(['XRP']);
    expect(portfolio.holdings.find((holding) => holding.ccy === 'USDT')?.costPriceExcluded).toBe(true);
    expect(portfolio.warnings.join(' ')).toContain('XRP');
    // No holding reports a P&L: the total is ABSENT, not a measured zero.
    expect(portfolio.totals.unrealizedPnlUsd).toBeNull();
    expect(portfolio.totals.unrealizedPnlEur).toBeNull();
  });

  it('leaves every EUR figure null when the FX read failed, and says so', () => {
    const portfolio = buildOkxPortfolio({
      balance: parseOkxBalance(balance),
      funding: [],
      savings: [],
      staking: [],
      positions: [],
      tickers: {},
      usdEur: null,
    });
    expect(portfolio.holdings.find((holding) => holding.ccy === 'BTC')?.valueEur).toBeNull();
    expect(portfolio.totals.holdingsValueEur).toBeNull();
    expect(portfolio.warnings.join(' ')).toContain('USD→EUR');
  });

  it('declares a residual between OKX totalEq and the holdings instead of hiding it', () => {
    const portfolio = buildOkxPortfolio({
      balance: { ...parseOkxBalance(balance), totalEquityUsd: 20000 },
      funding: [],
      savings: [],
      staking: [],
      positions: [],
      tickers: {},
      usdEur: 0.9,
    });
    expect(portfolio.warnings.join(' ')).toContain('totalEq');
  });

  it('merges the four wallets of one coin into ONE holding and names where it sits', () => {
    const portfolio = buildOkxPortfolio({
      balance: parseOkxBalance(balance),
      funding: parseOkxFundingBalances(funding),
      savings: parseOkxSavingsBalances(savings),
      staking: [],
      positions: [],
      tickers: parseOkxTickers([{ instId: 'BTC-USDT', last: '65000' }]),
      usdEur: 0.9,
    });
    const btc = portfolio.holdings.find((holding) => holding.ccy === 'BTC');
    expect(btc).toMatchObject({
      quantityTrading: 0.1,
      quantityFunding: 0.02,
      quantitySavings: 0.5,
      quantityEarn: 0,
      wallets: ['trading', 'funding', 'savings'],
    });
    expect(btc?.quantity).toBeCloseTo(0.62);
    // 6500 from OKX's eqUsd + 0.02·65000 funding + 0.5·65000 Simple Earn.
    expect(btc?.valueUsd).toBeCloseTo(6500 + 1300 + 32500);
    expect(portfolio.totals.savingsValueUsd).toBeCloseTo(32500);
    expect(portfolio.totals.earnValueUsd).toBe(0);
  });

  it('counts an On-chain Earn order at its PRINCIPAL: the earnings already sit in funding', () => {
    const portfolio = buildOkxPortfolio({
      balance: { details: [], totalEquityUsd: null },
      funding: [{ ccy: 'TRX', quantity: 0.16065194, available: 0.16065194 }],
      savings: [],
      staking: parseOkxStakingOrders(staking),
      positions: [],
      tickers: { 'TRX-USDT': 0.3 },
      usdEur: 1,
    });
    const trx = portfolio.holdings[0];
    expect(trx?.quantityFunding).toBeCloseTo(0.16065194);
    expect(trx?.quantityEarn).toBeCloseTo(954.522039);
    // Adding the 0.16065194 of earnings would count the same coin twice.
    expect(trx?.quantity).toBeCloseTo(954.68269094);
    expect(trx?.wallets).toEqual(['funding', 'earn']);
  });

  it('prices an Earn-only coin from its ticker and names the one no pair reaches', () => {
    const portfolio = buildOkxPortfolio({
      balance: { details: [], totalEquityUsd: null },
      funding: [],
      savings: [
        { ccy: 'ADA', amount: 100, loanAmount: 100, pendingAmount: 0 },
        { ccy: 'NOPE', amount: 5, loanAmount: 5, pendingAmount: 0 },
      ],
      staking: [],
      positions: [],
      tickers: { 'ADA-USDT': 0.5 },
      usdEur: 1,
    });
    expect(portfolio.holdings.find((holding) => holding.ccy === 'ADA')?.valueUsd).toBe(50);
    expect(portfolio.holdings.find((holding) => holding.ccy === 'NOPE')?.valueUsd).toBeNull();
    expect(portfolio.totals.unpriced).toEqual(['NOPE']);
    expect(portfolio.totals.savingsValueUsd).toBe(50);
  });
});
