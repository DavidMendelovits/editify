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
-- Apply as `postgres` (the Supabase migration role), which then owns the
-- tables. The server connects as that owner, which RLS does not apply to.
-- Signed-in clients may READ their own rows through the Data API; every
-- write goes through the server, because a direct UPDATE could skip the
-- revision check and the shared apply.
--
-- The foreign keys to auth.users take a SHARE ROW EXCLUSIVE lock on it while
-- they are created. lock_timeout makes the migration give up after 3 s rather
-- than queue sign-ups and token refreshes (GoTrue writes) behind it; if it
-- fails with "canceling statement due to lock timeout", just run it again.
--
-- If a sync_* table already exists without a column this file expects, the
-- guard below aborts before anything is created or changed.
--
-- Growth: every log row keeps a full after_doc, which is what lets undo, redo
-- and revert_run restore exactly. Retention plan, once size matters: keep
-- after_doc only on the newest N rows per project (say 200, past the device's
-- undo depth) plus periodic snapshots, set older after_doc to a reference to
-- the nearest snapshot, and rebuild by replaying `ops` forward from it.
-- Receipts older than a retry window (say 30 days) can be deleted outright.

set lock_timeout = '3s';

do $$
declare
  required constant jsonb := '{
    "sync_projects": ["id", "user_id", "title", "doc", "revision", "last_seq", "created_at", "updated_at"],
    "sync_op_log": ["project_id", "seq", "user_id", "kind", "ops", "revision", "after_doc", "undone",
                    "run_id", "undo_target_seq", "change_id", "created_at"],
    "sync_receipts": ["project_id", "change_id", "user_id", "base_revision", "revision", "seq", "hash",
                      "request_digest", "created_at"]
  }';
  required_table text;
  required_column text;
begin
  for required_table in select jsonb_object_keys(required) loop
    if to_regclass('public.' || required_table) is not null then
      for required_column in select jsonb_array_elements_text(required -> required_table) loop
        if not exists (
          select 1 from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = required_table and c.column_name = required_column
        ) then
          raise exception 'public.% already exists without column %; it is not the table this migration creates, so nothing was applied', required_table, required_column;
        end if;
      end loop;
    end if;
  end loop;
end $$;

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
  -- The client's change id. Only the 'create' row has none. Unique per
  -- project through sync_receipts' primary key: every logged change writes
  -- its receipt in the same transaction, so no second index is kept here.
  change_id text,
  created_at timestamptz not null default now(),
  primary key (project_id, seq),
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
  -- sha256 of the change minus its id. A reused change id with a different
  -- change is refused (409 change_id_reused) instead of getting this receipt.
  request_digest text not null,
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

-- Supabase grants anon and authenticated every table privilege by default
-- (MAINTAIN too, on Postgres 17). With no write policy RLS already refuses
-- writes; taking everything back and granting only SELECT makes the refusal
-- explicit and survives a permissive policy added later.
revoke all on public.sync_projects, public.sync_op_log, public.sync_receipts from anon, authenticated;
grant select on public.sync_projects, public.sync_op_log, public.sync_receipts to authenticated;

reset lock_timeout;
