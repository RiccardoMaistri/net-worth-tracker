'use client';

/**
 * Impostazioni › Collegamenti — the read-only broker bridges (their own tiles, their own
 * sessions) on one full-width row. No slice: a connection is established where it is shown,
 * never through «Salva».
 */

import { BrokerConnectionsSection } from '@/components/settings/BrokerConnectionsSection';
import { TILE_CELL_CLASS } from '@/components/ui/tile';
import { cn } from '@/lib/utils';
import { SettingsTabPanel } from './shared';

interface CollegamentiTabProps {
  /** Whose broker connections are shown. */
  ownerId: string;
  /** In demo nothing writes: the section's controls are disabled. */
  isDemo: boolean;
}

export function CollegamentiTab({ ownerId, isDemo }: CollegamentiTabProps) {
  return (
    <SettingsTabPanel tab="collegamenti" label="Collegamenti">
      <div className={cn(TILE_CELL_CLASS, 'desktop:col-span-12')}>
        <BrokerConnectionsSection ownerId={ownerId} disabled={isDemo} />
      </div>
    </SettingsTabPanel>
  );
}
