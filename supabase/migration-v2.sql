-- SwitchBoard multi-tenant migration v2
-- Matches the businessdeskzone signup pattern:
--   admin generates a signup link with a client_id
--   recipient opens ?portal=CLI-xxx and claims the row
--   pause / freeze / delete controlled from a separate admin.html
-- Safe to re-run.

------------------------------------------------------------
-- 1) Schema additions
------------------------------------------------------------
alter table public.sb_businesses
  add column if not exists client_id             text unique,
  add column if not exists owner_user_id         uuid references auth.users(id) on delete cascade,
  add column if not exists is_paused             boolean not null default false,
  add column if not exists frozen                boolean not null default false,
  add column if not exists ai_prompt             text,
  add column if not exists vapi_api_key          text,
  add column if not exists vapi_phone_number_id  text,
  add column if not exists vapi_assistant_id     text;

create index if not exists sb_businesses_owner_idx     on public.sb_businesses(owner_user_id);
create index if not exists sb_businesses_client_id_idx on public.sb_businesses(client_id);

------------------------------------------------------------
-- 2) Admins table (opt-in list of user ids)
------------------------------------------------------------
create table if not exists public.sb_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.sb_admins enable row level security;
drop policy if exists "admins_self_read" on public.sb_admins;
create policy "admins_self_read" on public.sb_admins for select
  using (user_id = auth.uid());
-- (only server-role can insert/delete admin rows — do it in the SQL editor)

create or replace function public.sb_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sb_admins where user_id = auth.uid());
$$;
grant execute on function public.sb_is_admin() to anon, authenticated;

------------------------------------------------------------
-- 3) Row Level Security on data tables
------------------------------------------------------------
alter table public.sb_businesses      enable row level security;
alter table public.sb_calls           enable row level security;
alter table public.sb_bookings        enable row level security;
alter table public.sb_orders          enable row level security;
alter table public.sb_pending_changes enable row level security;

-- drop any older versions of the policies
drop policy if exists "businesses_select_own"        on public.sb_businesses;
drop policy if exists "businesses_insert_own"        on public.sb_businesses;
drop policy if exists "businesses_update_own"        on public.sb_businesses;
drop policy if exists "businesses_delete_own"        on public.sb_businesses;
drop policy if exists "biz_owner_select"             on public.sb_businesses;
drop policy if exists "biz_admin_select"             on public.sb_businesses;
drop policy if exists "biz_public_lookup_unclaimed"  on public.sb_businesses;
drop policy if exists "biz_owner_update"             on public.sb_businesses;
drop policy if exists "biz_admin_update"             on public.sb_businesses;
drop policy if exists "biz_claim_unclaimed"          on public.sb_businesses;
drop policy if exists "biz_admin_insert"             on public.sb_businesses;
drop policy if exists "biz_admin_delete"             on public.sb_businesses;

-- Owner reads own row
create policy "biz_owner_select" on public.sb_businesses for select
  using (owner_user_id = auth.uid());
-- Admin reads every row
create policy "biz_admin_select" on public.sb_businesses for select
  using (public.sb_is_admin());
-- Portal lookup: anyone can read UNCLAIMED rows (needed before signup).
-- Rows with owner_user_id null contain only client_id and admin-set fields;
-- client_id is a random unguessable slug used as the one-time signup ticket.
create policy "biz_public_lookup_unclaimed" on public.sb_businesses for select
  using (owner_user_id is null);

-- Owner may update own row (but cannot change ownership or admin/freeze flags via app)
create policy "biz_owner_update" on public.sb_businesses for update
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
-- Admin may update any row
create policy "biz_admin_update" on public.sb_businesses for update
  using (public.sb_is_admin()) with check (true);
-- Claim: an authenticated user may claim an UNCLAIMED row by setting owner_user_id = self
create policy "biz_claim_unclaimed" on public.sb_businesses for update
  using (owner_user_id is null and auth.uid() is not null)
  with check (owner_user_id = auth.uid());

-- Only admins can insert (generate a signup link) or delete
create policy "biz_admin_insert" on public.sb_businesses for insert
  with check (public.sb_is_admin());
create policy "biz_admin_delete" on public.sb_businesses for delete
  using (public.sb_is_admin());

------------------------------------------------------------
-- 4) Child tables: owner OR admin can do everything for rows
--    whose parent business belongs to them (or admin).
------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sb_calls','sb_bookings','sb_orders','sb_pending_changes'] loop
    execute format('drop policy if exists "%1$s_all_own" on public.%1$s;', t);
    execute format($f$
      create policy "%1$s_all_own" on public.%1$s
        for all
        using (
          public.sb_is_admin()
          or exists (select 1 from public.sb_businesses b
                     where b.id = %1$s.business_id and b.owner_user_id = auth.uid()))
        with check (
          public.sb_is_admin()
          or exists (select 1 from public.sb_businesses b
                     where b.id = %1$s.business_id and b.owner_user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

------------------------------------------------------------
-- 5) Make yourself the first admin
------------------------------------------------------------
-- After you sign up your own account in Supabase (Auth › Users), copy your
-- user UUID and run:
--   insert into public.sb_admins(user_id) values ('<YOUR_AUTH_USER_ID>');
-- Then reload admin.html.
