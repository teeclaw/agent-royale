import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Agent Royale',
  description: 'Privacy-first gaming on Base',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href="/" className="font-semibold tracking-tight">
              agent<span className="text-primary">Royale</span>
            </Link>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/">Home</Link>
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/arena">Arena</Link>
              <Link href="/agent">Agent</Link>
            </div>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
