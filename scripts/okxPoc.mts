/**
 * OKX POC — what the account holds, and the P&L OKX itself reports, from the command line.
 *
 *   npm run okx:poc            # the table
 *   npm run okx:poc -- --json  # the same answer the route returns
 *   npm run okx:poc -- --raw   # OKX's own payloads, to check the fields against the real account
 *
 * Reads `.env.local` (the same file Next reads) and needs OKX_API_KEY / OKX_API_SECRET /
 * OKX_API_PASSPHRASE. `OKX_BASE_URL` defaults to `https://eea.okx.com` — a key created on
 * my.okx.com is refused by `www.okx.com` with 50111. `OKX_DEMO=true` reads the demo account.
 *
 * READ-ONLY BY CONSTRUCTION: the only endpoints the client can call are in the whitelist of
 * `lib/server/okxClient.ts`, and every one of them is a GET.
 *
 * A throwaway run never writes to Firestore and never touches the app's assets: this is the
 * measurement step, not the sync.
 */

import { okxBaseUrl, isOkxConfigured, isOkxDemo, readOkxAccount } from '@/lib/server/okxClient';
import { getExchangeRateToEur } from '@/lib/services/currencyConversionService';
import {
  buildOkxPortfolio,
  parseOkxBalance,
  parseOkxFundingBalances,
  parseOkxPositions,
  parseOkxSavingsBalances,
  parseOkxStakingOrders,
  parseOkxTickers,
  type OkxHolding,
  type OkxPortfolio,
} from '@/lib/utils/okxPortfolio';

const flags = new Set(process.argv.slice(2));
const asJson = flags.has('--json');
const asRaw = flags.has('--raw');

const usd = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const eur = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});
const quantityFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 8 });
const percent = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 2 });
const fetchedAtFormat = new Intl.DateTimeFormat('it-IT', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Rome',
});

function money(value: number | null, format: Intl.NumberFormat): string {
  return value === null ? '—' : format.format(value);
}

function quantity(value: number): string {
  return quantityFormat.format(value);
}

function pnl(value: number | null, format: Intl.NumberFormat): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${format.format(value)}`;
}

function ratio(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${percent.format(value)}`;
}

/** `padStart` on a rendered cell: the table is read, not parsed. */
function cell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function printTable(portfolio: OkxPortfolio): void {
  const rows = portfolio.holdings.map((holding: OkxHolding) => ({
    coin: holding.ccy,
    quantity: quantity(holding.quantity),
    valueUsd: money(holding.valueUsd, usd),
    valueEur: money(holding.valueEur, eur),
    pnlUsd: pnl(holding.unrealizedPnlUsd, usd),
    pnlRatio: holding.costPriceExcluded ? 'n/d' : ratio(holding.unrealizedPnlRatio),
    cumulative: pnl(holding.cumulativeCostPnlUsd, usd),
    wallets: holding.wallets.join('+'),
  }));

  const headers = {
    coin: 'Moneta',
    quantity: 'Quantità',
    valueUsd: 'Valore USD',
    valueEur: 'Valore EUR',
    pnlUsd: 'P/L USD',
    pnlRatio: 'P/L %',
    cumulative: 'P/L cumul. USD',
    wallets: 'Wallet',
  };

  const widths = {
    coin: Math.max(headers.coin.length, ...rows.map((row) => row.coin.length)),
    quantity: Math.max(headers.quantity.length, ...rows.map((row) => row.quantity.length)),
    valueUsd: Math.max(headers.valueUsd.length, ...rows.map((row) => row.valueUsd.length)),
    valueEur: Math.max(headers.valueEur.length, ...rows.map((row) => row.valueEur.length)),
    pnlUsd: Math.max(headers.pnlUsd.length, ...rows.map((row) => row.pnlUsd.length)),
    pnlRatio: Math.max(headers.pnlRatio.length, ...rows.map((row) => row.pnlRatio.length)),
    cumulative: Math.max(headers.cumulative.length, ...rows.map((row) => row.cumulative.length)),
    wallets: Math.max(headers.wallets.length, ...rows.map((row) => row.wallets.length)),
  };

  console.log(
    [
      cell(headers.coin, widths.coin),
      cell(headers.quantity, widths.quantity, 'right'),
      cell(headers.valueUsd, widths.valueUsd, 'right'),
      cell(headers.valueEur, widths.valueEur, 'right'),
      cell(headers.pnlUsd, widths.pnlUsd, 'right'),
      cell(headers.pnlRatio, widths.pnlRatio, 'right'),
      cell(headers.cumulative, widths.cumulative, 'right'),
      cell(headers.wallets, widths.wallets),
    ].join('  ')
  );
  for (const row of rows) {
    console.log(
      [
        cell(row.coin, widths.coin),
        cell(row.quantity, widths.quantity, 'right'),
        cell(row.valueUsd, widths.valueUsd, 'right'),
        cell(row.valueEur, widths.valueEur, 'right'),
        cell(row.pnlUsd, widths.pnlUsd, 'right'),
        cell(row.pnlRatio, widths.pnlRatio, 'right'),
        cell(row.cumulative, widths.cumulative, 'right'),
        cell(row.wallets, widths.wallets),
      ].join('  ')
    );
  }
}

function printTotals(portfolio: OkxPortfolio): void {
  const { totals } = portfolio;
  console.log('');
  console.log('Totali');
  console.log(`  Valore delle monete (4 wallet)          ${money(totals.holdingsValueUsd, usd)}  /  ${money(totals.holdingsValueEur, eur)}`);
  console.log(`  di cui trading                          ${money(totals.tradingValueUsd, usd)}`);
  console.log(`  di cui funding                          ${money(totals.fundingValueUsd, usd)}`);
  console.log(`  di cui Simple Earn                      ${money(totals.savingsValueUsd, usd)}`);
  console.log(`  di cui On-chain Earn                    ${money(totals.earnValueUsd, usd)}`);
  console.log(`  P/L non realizzato (costo medio OKX)    ${pnl(totals.unrealizedPnlUsd, usd)}  /  ${pnl(totals.unrealizedPnlEur, eur)}`);
  if (totals.accountEquityUsd !== null) {
    console.log(`  totalEq del conto trading               ${money(totals.accountEquityUsd, usd)}`);
  }
  if (portfolio.positions.length > 0) {
    console.log('');
    console.log(`Posizioni derivative aperte (${portfolio.positions.length})`);
    for (const position of portfolio.positions) {
      console.log(
        `  ${position.instId}  ${position.posSide || position.instType}  q.tà ${quantity(position.quantity)}  nozionale ${money(position.notionalUsd, usd)}  P/L ${pnl(position.unrealizedPnlUsd, usd)} (${ratio(position.unrealizedPnlRatio)})`
      );
    }
    console.log(`  P/L non realizzato delle posizioni      ${pnl(totals.derivativesUnrealizedPnlUsd, usd)}`);
  }
}

async function main(): Promise<void> {
  const nextEnv = (await import('@next/env')) as {
    default?: { loadEnvConfig(directory: string): unknown };
    loadEnvConfig?(directory: string): unknown;
  };
  (nextEnv.default ?? nextEnv).loadEnvConfig?.(process.cwd());

  if (!isOkxConfigured()) {
    throw new Error(
      'OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE mancanti in .env.local (oppure esportali nella shell).'
    );
  }

  const [raw, usdEur] = await Promise.all([
    readOkxAccount(),
    getExchangeRateToEur('USD').catch(() => null),
  ]);

  if (asRaw) {
    console.log(JSON.stringify({ baseUrl: okxBaseUrl(), demo: isOkxDemo(), raw }, null, 2));
    return;
  }

  const portfolio = buildOkxPortfolio({
    balance: raw.balance === null ? { details: [], totalEquityUsd: null } : parseOkxBalance(raw.balance),
    funding: parseOkxFundingBalances(raw.funding ?? []),
    savings: parseOkxSavingsBalances(raw.savings ?? []),
    staking: parseOkxStakingOrders(raw.staking ?? []),
    positions: parseOkxPositions(raw.positions ?? []),
    tickers: parseOkxTickers(raw.tickers),
    usdEur,
  });
  const warnings = [...raw.warnings, ...portfolio.warnings];

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          portfolio: { ...portfolio, warnings },
          meta: {
            baseUrl: okxBaseUrl(),
            demo: isOkxDemo(),
            usdEur,
            fetchedAt: new Date().toISOString(),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `OKX${isOkxDemo() ? ' (demo)' : ''} · ${okxBaseUrl()} · ${fetchedAtFormat.format(new Date())}`
  );
  console.log(
    `Cambio USD→EUR ${usdEur === null ? 'non disponibile' : `1 USD = ${usdEur.toFixed(4)} EUR`}`
  );
  console.log('');
  printTable(portfolio);
  printTotals(portfolio);

  if (warnings.length > 0) {
    console.log('');
    console.log('Avvisi');
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
}

main().catch((error) => {
  console.error(`Lettura OKX non riuscita: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
