create extension if not exists pg_net with schema extensions;

-- Keep the admin role server controlled. Engineers may edit only their own name.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now(),
  constraint push_endpoint_length check (length(endpoint) between 20 and 2048),
  constraint push_p256dh_length check (length(p256dh) between 40 and 256),
  constraint push_auth_key_length check (length(auth_key) between 8 and 128)
);

create index push_subscriptions_user_id_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;

create policy push_subscriptions_admin_select on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_admin()));
create policy push_subscriptions_admin_insert on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy push_subscriptions_admin_update on public.push_subscriptions
  for update to authenticated using (user_id = (select auth.uid()) and (select public.is_admin()))
  with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy push_subscriptions_admin_delete on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()) and (select public.is_admin()));

revoke all on public.push_subscriptions from public, anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

create table public.push_dispatches (
  submission_id uuid primary key references public.submissions(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.push_dispatches enable row level security;
revoke all on public.push_dispatches from public, anon, authenticated;
grant all on public.push_dispatches to service_role;

create or replace function public.get_push_secrets()
returns jsonb
language sql stable security definer set search_path = ''
as $function$
  select case when (select auth.role()) = 'service_role' then jsonb_build_object(
    'vapid_private_key', (select decrypted_secret from vault.decrypted_secrets where name = 'obra_push_vapid_private'),
    'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'obra_push_webhook_secret')
  ) else null end;
$function$;
revoke all on function public.get_push_secrets() from public, anon, authenticated;
grant execute on function public.get_push_secrets() to service_role;

create or replace function public.claim_push_dispatch(p_submission_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare claimed boolean;
begin
  if (select auth.role()) <> 'service_role' then return false; end if;
  insert into public.push_dispatches (submission_id) values (p_submission_id)
  on conflict (submission_id) do update set claimed_at = now()
    where public.push_dispatches.completed_at is null
      and public.push_dispatches.claimed_at < now() - interval '5 minutes'
  returning true into claimed;
  return coalesce(claimed, false);
end;
$function$;
revoke all on function public.claim_push_dispatch(uuid) from public, anon, authenticated;
grant execute on function public.claim_push_dispatch(uuid) to service_role;

create or replace function public.queue_engineer_push()
returns trigger
language plpgsql security definer set search_path = ''
as $function$
declare webhook_secret text;
declare signature text;
begin
  if not exists (select 1 from public.profiles where id = new.submitted_by and role = 'engineer') then
    return new;
  end if;
  select decrypted_secret into webhook_secret
    from vault.decrypted_secrets where name = 'obra_push_webhook_secret';
  if webhook_secret is null then return new; end if;
  signature := encode(extensions.hmac(convert_to(new.id::text, 'utf8'), convert_to(webhook_secret, 'utf8'), 'sha256'), 'hex');
  perform net.http_post(
    url := 'https://gtbzawhsatifcjcpliyc.supabase.co/functions/v1/notify-progress',
    body := jsonb_build_object('submission_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-submission-signature', signature),
    timeout_milliseconds := 10000
  );
  return new;
end;
$function$;
revoke all on function public.queue_engineer_push() from public, anon, authenticated;

create trigger notify_engineer_submission
  after insert on public.submissions
  for each row execute function public.queue_engineer_push();
