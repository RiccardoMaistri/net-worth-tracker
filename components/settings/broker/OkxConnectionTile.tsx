/** OKX tile — Collegamenti. Appears when OKX_API_* are set and user is in allowlist. */
'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { canUseOkx } from '@/lib/utils/okxAccess';
import { Tile } from '@/components/ui/tile';

const BROKER = 'okx' as const;

export function OkxConnectionTile({ ownerId, disabled = false }: { ownerId: string; disabled?: boolean }) {
  const { user } = useAuth();
  const [showTile, setShowTile] = useState(true);

  useEffect(() => {
    // The tile visibility is controlled by the parent's canUseOkx check,
    // but we also gate here for safety.
    if (user?.email && !canUseOkx(user.email)) {
      setShowTile(false);
    }
  }, [user?.email]);

  if (disabled || !showTile) return null;

  return (
    <Tile eyebrow="OKX" aside="mai letto" reading="mai letto">
      <div className="mt-3 p-4 text-sm text-muted-foreground">
        <p>Collegamento OKX configurato</p>
        <p className="mt-2">
          <a href="/dashboard/settings?tab=collegamenti" className="underline">
            Vai alle impostazioni OKX
          </a>
        </p>
      </div>
    </Tile>
  );
}