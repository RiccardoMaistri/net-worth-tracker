import type { FIREProjectionScenarios } from '@/types/assets';

/**
 * Default scenario parameters for FIRE projections.
 * Bear: conservative growth with higher inflation (stagflation-like).
 * Base: historical average returns with moderate inflation.
 * Bull: strong growth with low inflation (Goldilocks economy).
 *
 * Lives in a pure module (not `fireService`) because the server's Panoramica projection also
 * reads the base growth rate, and `fireService` reaches the client Firebase SDK through
 * `expenseService` (AGENTS.md → Server Layer and API Authorization).
 */
export function getDefaultScenarios(): FIREProjectionScenarios {
  return {
    bear: { growthRate: 4.0, inflationRate: 3.5 },
    base: { growthRate: 7.0, inflationRate: 2.5 },
    bull: { growthRate: 10.0, inflationRate: 1.5 },
  };
}
