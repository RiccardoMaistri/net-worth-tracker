/**
 * OKX read-only POC — POST /api/broker/okx/poc.
 *
 * The POC was folded into the bridge's read endpoint when the OKX integration became real; this
 * path stays as a thin alias so its published contract (one row per coin, OKX's own spot P&L,
 * derivatives apart, read warnings, owner scoping and Server-Timing) keeps answering. No business
 * logic lives here — `/api/broker/okx/read` is the one implementation.
 */

export const runtime = 'nodejs';

export { POST } from '@/app/api/broker/okx/read/route';
