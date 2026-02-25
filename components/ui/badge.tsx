import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type SpanProps = HTMLAttributes<HTMLSpanElement>;

export function Badge({ className, ...props }: SpanProps) {
  return <span className={cn('inline-flex items-center rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground', className)} {...props} />;
}
