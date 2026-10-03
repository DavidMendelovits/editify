-- Device-authoritative project sync (plan decision 4A, outside voice OV4).
--
-- The phone owns the project (D3). The Fly server is stateless and writes here
-- in one transaction per change: lock the project row, check the revision,
-- dedupe by the client's change id, apply the ops, then write the document,
-- the ordered log row and the receipt together.
--
--   sync_projects   current document + revision per project
--   sync_op_log     one row per committed change, ordered by (project_id, seq)
--   sync_receipts   what each client change id produced, for retries
--
-- Additive only: new tables, nothing existing is altered. Safe to re-run.
--
-- Access: the server connects as the table owner (postgres), which RLS does
-- not apply to. Signed-in clients may READ their own rows through the Data
-- API; every write goes through the server, because a direct UPDATE could
-- skip the revision check and the shared apply.

create table if not exists public.sync_projects (
  -- The phone mints project ids, so this is text rather than uuid.
  id text primary key check (char_length(id) between 1 and 128),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '',
  doc jsonb not null,
  -- The device revision: doc->'version' always equals it.
  revision bigint not null check (revision >= 0),
  -- The newest seq in sync_op_log, kept here so the next one is assigned
  -- under the row lock instead of from a MAX() that two writers could share.
  last_seq bigint not null default 0 check (last_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sync_projects_user_idx
  on public.sync_projects (user_id, updated_at desc);

create table if not exists public.sync_op_log (
  project_id text not null references public.sync_projects (id) on delete cascade,
  -- Explicit per-project order (OV4): 1, 2, 3 ... with no gaps, assigned
  -- from sync_projects.last_seq while the project row is locked.
  seq bigint not null check (seq > 0),
  -- Copied from the project so RLS needs no join.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'create' is seq 1: the document as first pushed, so every later row has
  -- a predecessor whose after_doc is its before-document.
  kind text not null check (kind in ('create', 'edit', 'undo', 'redo', 'revert_run')),
  -- The ops as pushed. A history row holds its single undo/redo/revert_run op.
  ops jsonb not null default '[]'::jsonb check (jsonb_typeof(ops) = 'array'),
  -- The revision this row produced; the document at it is after_doc.
  revision bigint not null check (revision >= 0),
  after_doc jsonb not null,
  -- History state, as in the SQLite operation_log: an undone row is retracted.
  -- A redo row is logged already undone, so repeated redos walk the undo stack.
  undone boolean not null default false,
  -- The agent turn (proposal) this edit belongs to, for revert_run.
  run_id text,
  -- On an undo row: the seq it retracted, which a later redo restores.
  undo_target_seq bigint,
  -- The client's change id. Only the 'create' row has none.
  change_id text,
  created_at timestamptz not null default now(),
  primary key (project_id, seq),
  unique (project_id, change_id),
  check ((kind = 'create') = (change_id is null))
);
create index if not exists sync_op_log_run_idx
  on public.sync_op_log (project_id, run_id) where run_id is not null;
create index if not exists sync_op_log_user_idx
  on public.sync_op_log (user_id);

create table if not exists public.sync_receipts (
  project_id text not null references public.sync_projects (id) on delete cascade,
  change_id text not null check (char_length(change_id) between 1 and 128),
  user_id uuid not null references auth.users (id) on delete cascade,
  base_revision bigint not null,
  -- Equal to base_revision when the change was a no-op.
  revision bigint not null,
  -- The log row it wrote, or null for a no-op (which writes none).
  seq bigint,
  -- projectHash of the document after the change (packages/shared).
  hash text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, change_id)
);
create index if not exists sync_receipts_user_idx
  on public.sync_receipts (user_id);

alter table public.sync_projects enable row level security;
alter table public.sync_op_log enable row level security;
alter table public.sync_receipts enable row level security;

drop policy if exists sync_projects_select_own on public.sync_projects;
create policy sync_projects_select_own on public.sync_projects
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists sync_op_log_select_own on public.sync_op_log;
create policy sync_op_log_select_own on public.sync_op_log
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists sync_receipts_select_own on public.sync_receipts;
create policy sync_receipts_select_own on public.sync_receipts
  for select to authenticated using ((select auth.uid()) = user_id);

-- Supabase grants anon and authenticated full table privileges by default.
-- With no write policy RLS already refuses writes; revoking them as well
-- makes the refusal explicit and survives a permissive policy added later.
revoke all on public.sync_projects, public.sync_op_log, public.sync_receipts from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.sync_projects, public.sync_op_log, public.sync_receipts from authenticated;
grant select on public.sync_projects, public.sync_op_log, public.sync_receipts to authenticated;
