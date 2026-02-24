# VM -> Supabase Migration Runbook (Phase 1)

## 1) Export VM state

```bash
cd agent-casino
node migration/export-vm-state.mjs
```

Produces:
- `migration/snapshots/vm-export-<timestamp>.json`

## 2) Import snapshot into Supabase

```bash
cd agent-casino
export SUPABASE_URL='https://<project>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<service-role-key>'
node migration/import-snapshot-to-supabase.mjs migration/snapshots/vm-export-<timestamp>.json
```

## 3) Verify via Vercel API

- `/api/health`
- `/api/dashboard/state`
- `/api/arena/agents`
- `/api/arena/recent`

## Notes

- This is a **snapshot migration**, not continuous replication.
- Repeat export/import when you need a fresher backfill.
- Full write-path migration is Phase 2 (`/api/a2a/casino` on Vercel).
