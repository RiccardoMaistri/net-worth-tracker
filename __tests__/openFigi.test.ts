/**
 * Tests for lib/server/openFigi.ts — the ISIN → Yahoo symbol second source.
 *
 * The load-bearing properties: the US listing wins bare, EUR venues follow a fixed order,
 * unknown exchange codes are skipped (never guessed into a suffix), and EVERY failure —
 * rate limit, network, malformed answer — resolves to «no resolution» instead of breaking
 * the sync that asked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickYahooSymbol, resolveIsinsViaOpenFigi } from '@/lib/server/openFigi';

describe('pickYahooSymbol', () => {
  it('takes the bare US ticker over every foreign listing', () => {
    expect(
      pickYahooSymbol([
        { ticker: 'VWCE', exchCode: 'GR' },
        { ticker: 'TSLA', exchCode: 'US' },
        { ticker: 'STLAM', exchCode: 'MI' },
      ])
    ).toBe('TSLA');
  });

  it('prefers EUR venues in a fixed order, home first', () => {
    expect(
      pickYahooSymbol([
        { ticker: 'VWCE', exchCode: 'GR' },
        { ticker: 'STLAM', exchCode: 'MI' },
      ])
    ).toBe('STLAM.MI');
  });

  it('maps each known venue to its Yahoo suffix', () => {
    expect(pickYahooSymbol([{ ticker: 'VOW3', exchCode: 'GR' }])).toBe('VOW3.DE');
    expect(pickYahooSymbol([{ ticker: 'INRA', exchCode: 'NA' }])).toBe('INRA.AS');
    expect(pickYahooSymbol([{ ticker: 'MC', exchCode: 'FP' }])).toBe('MC.PA');
  });

  it('returns null when only unknown venues exist — never an invented suffix', () => {
    expect(pickYahooSymbol([{ ticker: 'AMZN', exchCode: 'VY' }])).toBeNull();
    expect(pickYahooSymbol([{ ticker: 'AMZN', exchCode: 'MM' }])).toBeNull();
    expect(pickYahooSymbol([])).toBeNull();
  });

  it('ignores malformed listings instead of crashing', () => {
    expect(pickYahooSymbol([{ ticker: '', exchCode: 'US' }])).toBeNull();
  });
});

describe('resolveIsinsViaOpenFigi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function figiResponse(ticker: string, exchCode: string) {
    return { json: async () => [{ data: [{ ticker, exchCode }] }], ok: true };
  }

  it('resolves a batch through one POST and maps by ISIN', async () => {
    fetchMock.mockResolvedValueOnce(figiResponse('ONON', 'US'));
    const resolved = await resolveIsinsViaOpenFigi(['CH1134540470']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.openfigi.com/v3/mapping');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual([
      { idType: 'ID_ISIN', idValue: 'CH1134540470' },
    ]);
    expect(resolved.get('CH1134540470')).toBe('ONON');
  });

  it('splits over-long universes into batches of 10', async () => {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const jobs = JSON.parse((init as RequestInit).body as string) as unknown[];
      return { json: async () => jobs.map(() => ({})), ok: true };
    });
    const isins = Array.from({ length: 11 }, (_, i) => `US00000000${i}`);
    await resolveIsinsViaOpenFigi(isins);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toHaveLength(10);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toHaveLength(1);
  });

  it('dedupes and normalizes the input before sending', async () => {
    fetchMock.mockResolvedValueOnce(figiResponse('ONON', 'US'));
    await resolveIsinsViaOpenFigi([' ch1134540470 ', 'CH1134540470']);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual([
      { idType: 'ID_ISIN', idValue: 'CH1134540470' },
    ]);
  });

  it('returns an empty map on rate limit, network failure or malformed answer', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    await expect(resolveIsinsViaOpenFigi(['US0231351067'])).resolves.toEqual(new Map());

    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(resolveIsinsViaOpenFigi(['US0231351067'])).resolves.toEqual(new Map());

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nope: true }) });
    await expect(resolveIsinsViaOpenFigi(['US0231351067'])).resolves.toEqual(new Map());
  });
});
