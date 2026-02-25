'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { getDashboardState } from '@/lib/api';

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState | null>(null);

  useEffect(() => {
    getDashboardState().then(setState).catch(() => setState(null));
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Dashboard</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">House treasury</p><p className="mt-2 text-2xl font-semibold text-primary">{state?.funds?.houseTreasury ?? '-'}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Channel escrow</p><p className="mt-2 text-2xl font-semibold text-primary">{state?.funds?.channelEscrow ?? '-'}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Total managed</p><p className="mt-2 text-2xl font-semibold text-primary">{state?.funds?.totalManaged ?? '-'}</p></CardContent></Card>
      </div>
    </main>
  );
}
