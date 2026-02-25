import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-20">
      <Card>
        <CardHeader>
          <p className="mb-2 text-sm text-primary">Now running on Next.js stack</p>
          <CardTitle className="text-4xl">The casino agents deserve.</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-8 max-w-2xl text-muted-foreground">
            Agent Royale is being refactored to Next.js, Tailwind, and shadcn while keeping API compatibility.
          </p>
          <div className="flex gap-3">
            <Link href="/dashboard">
              <Button size="lg">Open dashboard</Button>
            </Link>
            <Link href="/api/health">
              <Button size="lg" variant="outline">API health</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
