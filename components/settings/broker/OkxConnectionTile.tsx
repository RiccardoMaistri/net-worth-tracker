/**
 * The OKX half of «Collegamenti» — read-only sync of trading, funding, Simple Earn and On-chain
 * Earn, every coin tracked as a `crypto` asset labelled «OKX». Same shape as the Binance tile:
 * the API key lives in the server environment, «Sincronizza» reads, builds the plan
 * (`buildOkxImportPlan`) and saves new coins and moved prices. Quantities stay the Registro's.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Tile } from '@/components/ui/tile';
import { describeBrokerConnections } from '@/lib/utils/settingsNarrative';
import { authenticatedFetch } from '@/lib/utils/authFetch';
import { errorMessage } from '@/lib/utils/errorMessage';
import { formatNumberIt } from '@/lib/utils/formatters';
import { queryKeys } from '@/lib/query/queryKeys';
import { buildOkxImportPlan, type OkxImportPlan, type OkxPortfolio } from '@/lib/utils/okxImport';
import {
  getBrokerConnection,
  saveBrokerConnection,
  type BrokerConnection,
} from '@/lib/services/brokerConnectionService';
import { createAsset, getAllAssets, updateAsset } from '@/lib/services/assetService';

interface OkxConnectionTileProps {
  ownerId: string;
  /** Disables all mutations (demo mode). */
  disabled?: boolean;
}

const BROKER = 'okx' as const;

async function readOkx(ownerId: string): Promise<{ portfolio: OkxPortfolio; usdEur: number | null }> {
  const response = await authenticatedFetch('/api/broker/okx/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : 'Lettura non riuscita: riprova.');
  }
  if (!Array.isArray(data?.portfolio?.holdings)) throw new Error('Lettura delle posizioni non riuscita: riprova.');
  const usdEur = typeof data?.meta?.usdEur === 'number' ? (data.meta.usdEur as number) : null;
  return { portfolio: data.portfolio as OkxPortfolio, usdEur };
}

async function applyPlan(
  ownerId: string,
  plan: OkxImportPlan
): Promise<{ createdAssets: number; updatedPrices: number }> {
  let createdAssets = 0;
  let updatedPrices = 0;
  for (const diff of plan.holdings) {
    if (diff.kind === 'new') {
      await createAsset(ownerId, diff.formData);
      createdAssets += 1;
    } else if (diff.kind === 'price-update' && diff.existingAssetId && diff.priceEur !== null) {
      await updateAsset(diff.existingAssetId, { currentPrice: diff.priceEur });
      updatedPrices += 1;
    }
  }
  return { createdAssets, updatedPrices };
}

interface SyncResult {
  plan: OkxImportPlan;
  notes: string[];
}

export function OkxConnectionTile({ ownerId, disabled = false }: OkxConnectionTileProps) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<BrokerConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const loadAll = useCallback(async () => {
    try {
      setConnection(await getBrokerConnection(ownerId, BROKER));
    } catch (err) {
      console.error('[OkxConnectionTile] load failed:', err);
      toast.error('Impossibile caricare i collegamenti broker');
    }
    setLoading(false);
  }, [ownerId]);

  useEffect(() => {
    // Deferred so the effect body itself sets no state (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAll]);

  const handleSync = async () => {
    if (disabled) return;
    setSyncing(true);
    setError(null);
    setResult(null);
    setStep('Lettura dei wallet OKX…');
    let wroteSomething = false;
    try {
      // A fresh read of the assets, not state: a stale list would create duplicates.
      const [{ portfolio, usdEur }, currentAssets] = await Promise.all([readOkx(ownerId), getAllAssets(ownerId)]);
      const plan = buildOkxImportPlan(portfolio.holdings, currentAssets, usdEur);
      setStep('Salvataggio di monete e prezzi…');
      const { createdAssets, updatedPrices } = await applyPlan(ownerId, plan);
      wroteSomething = createdAssets + updatedPrices > 0;
      await saveBrokerConnection(
        ownerId,
        { holdingsCount: plan.stats.holdingCount, createdAssets, updatedPrices },
        BROKER
      );
      setResult({ plan, notes: [...portfolio.warnings, ...plan.warnings] });
      const prices = updatedPrices > 0 ? `, ${updatedPrices} prezzi aggiornati` : '';
      toast.success(`Sincronizzazione completata: ${createdAssets} nuovi asset${prices}.`);
    } catch (err) {
      setError(errorMessage(err, 'Sincronizzazione non riuscita: riprova.'));
    }
    // After the try/catch rather than in a `finally`: the React Compiler cannot lower one.
    if (wroteSomething) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.assets.all(ownerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.overview(ownerId) }),
      ]);
    }
    await loadAll();
    setStep(null);
    setSyncing(false);
  };

  const reading = loading
    ? null
    : describeBrokerConnections(BROKER, {
        lastSyncAt: connection?.lastSyncAt.toISOString(),
        holdingsCount: connection?.holdingsCount,
      });

  return (
    <Tile eyebrow="OKX" aside={loading ? undefined : connection ? 'letto' : 'mai letto'} reading={reading}>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleSync} disabled={disabled || syncing || loading} className="h-10">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {syncing ? 'Sincronizzazione…' : 'Sincronizza'}
          </Button>
          {disabled && (
            <span className="text-xs text-muted-foreground">Modalità demo: sincronizzazione disattivata.</span>
          )}
        </div>

        {syncing && step && (
          <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
            <Loader2 className="size-6 flex-none animate-spin text-primary" aria-hidden />
            <span className="text-[13px]">{step}</span>
          </div>
        )}

        {error && (
          <p role="alert" className="text-[13px] leading-[1.45] text-destructive">
            {error}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium">
              {result.plan.stats.newCount} nuovi
              {result.plan.stats.priceUpdateCount > 0 && `, ${result.plan.stats.priceUpdateCount} prezzi aggiornati`}
              {result.plan.stats.driftCount > 0 && `, ${result.plan.stats.driftCount} scostamenti di quantità`}
              {result.plan.stats.unchangedCount > 0 && `, ${result.plan.stats.unchangedCount} invariati`}
              {result.plan.stats.skippedCount > 0 && `, ${result.plan.stats.skippedCount} non creati`}.
            </p>
            {result.plan.holdings.some((diff) => diff.kind === 'drift-only') && (
              <ul className="flex flex-col gap-1">
                {result.plan.holdings
                  .filter((diff) => diff.kind === 'drift-only')
                  .map((diff) => (
                    <li key={diff.holding.ccy} className="text-[12px] text-warning-foreground">
                      {diff.holding.ccy}: nel Registro scostamento di {formatNumberIt(diff.quantityDrift, 8)} — da
                      riconciliare a mano.
                    </li>
                  ))}
              </ul>
            )}
            {result.notes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {result.notes.map((note, index) => (
                  <li key={index} className="text-[12px] leading-[1.45] text-muted-foreground">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Tile>
  );
}
