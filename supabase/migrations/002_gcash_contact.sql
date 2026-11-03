create table if not exists public.store_settings (
  key text primary key,
  value text not null,
  constraint store_settings_gcash_number_format
    check (key <> 'gcash_number' or value ~ '^09[0-9]{9}$')
);

alter table public.store_settings enable row level security;
grant select, insert, update, delete on public.store_settings to service_role;

insert into public.store_settings (key, value)
values ('gcash_number', '09302846922')
on conflict (key) do nothing;
