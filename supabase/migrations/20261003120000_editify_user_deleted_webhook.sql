-- Editify: tell both API servers when a Supabase user is deleted (plan D16, C5).
--
-- Supabase Auth Hooks have no "user deleted" event, so this is a plain trigger
-- on auth.users. AFTER DELETE it queues one signed POST per server through
-- pg_net. pg_net sends only after the deleting transaction commits, so by the
-- time a server asks the admin API, the user is really gone. A rolled-back
-- delete sends nothing.
--
-- Contract (server/src/routes/webhooks.ts):
--   POST <server>/webhooks/supabase/user-deleted
--   body   {"type":"user.deleted","event_id":<uuid>,"user_id":<uuid>,"occurred_at":<ts>}
--   x-editify-webhook-timestamp: unix seconds
--   x-editify-webhook-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
-- pg_net sends the body as convert_to(body::text, 'UTF8'), which is exactly the
-- payload::text signed below. Both servers get the same event_id.
--
-- The HMAC key lives in Supabase Vault as 'editify_user_deleted_webhook_secret'
-- and must equal SUPABASE_WEBHOOK_SECRET on both Fly apps. Without it the
-- trigger only warns. Nothing here can ever block or fail a user delete.
--
-- pg_net does not retry. A delivery that fails (server down, read-only, 5xx) is
-- visible in net._http_response for a few hours, and the leftovers are removed
-- by server/scripts/orphan-sweep.ts.

create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists editify_private;
revoke all on schema editify_private from public, anon, authenticated;

create or replace function editify_private.notify_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  targets text[] := array[
    'https://editify-dm.fly.dev',
    'https://editify-v11.fly.dev'
  ];
  secret text;
  payload jsonb;
  ts text;
  signature text;
  target text;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'editify_user_deleted_webhook_secret'
  limit 1;
  if secret is null or secret = '' then
    raise warning 'editify user-deleted webhook: vault secret missing, nothing sent for %', old.id;
    return old;
  end if;

  payload := jsonb_build_object(
    'type', 'user.deleted',
    'event_id', gen_random_uuid()::text,
    'user_id', old.id::text,
    'occurred_at', clock_timestamp()::text
  );
  ts := floor(extract(epoch from clock_timestamp()))::bigint::text;
  signature := 'v1=' || encode(extensions.hmac(ts || '.' || payload::text, secret, 'sha256'), 'hex');

  foreach target in array targets loop
    perform net.http_post(
      url := target || '/webhooks/supabase/user-deleted',
      body := payload,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-editify-webhook-timestamp', ts,
        'x-editify-webhook-signature', signature
      ),
      timeout_milliseconds := 10000
    );
  end loop;
  return old;
exception when others then
  raise warning 'editify user-deleted webhook failed for %: %', old.id, sqlerrm;
  return old;
end;
$$;

revoke all on function editify_private.notify_user_deleted() from public, anon, authenticated;

drop trigger if exists editify_user_deleted on auth.users;
create trigger editify_user_deleted
  after delete on auth.users
  for each row execute function editify_private.notify_user_deleted();
