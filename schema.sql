-- ВашаСделка.Крипто. — схема для Supabase
-- Выполняйте целиком в Supabase SQL Editor.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  initial_cash numeric(18,2) not null default 0,
  initial_code numeric(18,8) not null default 0,
  lock_settings boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_number text not null,
  operator_name text not null default '',
  cycle_date date not null default current_date,
  status text not null default 'Открыт',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  row_no integer not null default 1,
  client_name text not null default '',
  cash_in numeric(18,2) not null default 0,
  cash_out numeric(18,2) not null default 0,
  code_in numeric(18,8) not null default 0,
  code_out numeric(18,8) not null default 0,
  other_rub numeric(18,2) not null default 0,
  code_adjustment numeric(18,8) not null default 0,
  notes text not null default '',
  tx_hash text not null default '',
  files jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cycles_user_date on public.cycles(user_id, cycle_date desc, created_at desc);
create index if not exists idx_deals_cycle_row on public.deals(cycle_id, row_no);
create index if not exists idx_deals_user_client on public.deals(user_id, client_name);

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

drop trigger if exists trg_cycles_updated_at on public.cycles;
create trigger trg_cycles_updated_at
before update on public.cycles
for each row execute function public.set_updated_at();

drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at
before update on public.deals
for each row execute function public.set_updated_at();

alter table public.app_settings enable row level security;
alter table public.cycles enable row level security;
alter table public.deals enable row level security;
drop policy if exists "app_settings_select_own" on public.app_settings;
drop policy if exists "app_settings_insert_own" on public.app_settings;
drop policy if exists "app_settings_update_own" on public.app_settings;
drop policy if exists "cycles_select_own" on public.cycles;
drop policy if exists "cycles_insert_own" on public.cycles;
drop policy if exists "cycles_update_own" on public.cycles;
drop policy if exists "cycles_delete_own" on public.cycles;
drop policy if exists "deals_select_own" on public.deals;
drop policy if exists "deals_insert_own" on public.deals;
drop policy if exists "deals_update_own" on public.deals;
drop policy if exists "deals_delete_own" on public.deals;
drop policy if exists "storage_select_own" on storage.objects;
drop policy if exists "storage_insert_own" on storage.objects;
drop policy if exists "storage_update_own" on storage.objects;
drop policy if exists "storage_delete_own" on storage.objects;

create policy "app_settings_select_own"
on public.app_settings
for select
using ((select auth.uid()) = user_id);

create policy "app_settings_insert_own"
on public.app_settings
for insert
with check ((select auth.uid()) = user_id);

create policy "app_settings_update_own"
on public.app_settings
for update
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "cycles_select_own"
on public.cycles
for select
using ((select auth.uid()) = user_id);

create policy "cycles_insert_own"
on public.cycles
for insert
with check ((select auth.uid()) = user_id);

create policy "cycles_update_own"
on public.cycles
for update
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "cycles_delete_own"
on public.cycles
for delete
using ((select auth.uid()) = user_id);

create policy "deals_select_own"
on public.deals
for select
using ((select auth.uid()) = user_id);

create policy "deals_insert_own"
on public.deals
for insert
with check ((select auth.uid()) = user_id);

create policy "deals_update_own"
on public.deals
for update
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "deals_delete_own"
on public.deals
for delete
using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public)
values ('client-files', 'client-files', false)
on conflict (id) do nothing;

create policy "storage_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "storage_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "storage_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "storage_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
