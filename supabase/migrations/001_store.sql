create extension if not exists pgcrypto;

create table if not exists public.store_products (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80),
  category text not null check (char_length(category) between 1 and 50),
  price numeric(10, 2) not null check (price > 0 and price <= 100000),
  stock integer not null check (stock >= 0 and stock <= 100000),
  emoji text not null check (char_length(emoji) between 1 and 8),
  description text not null default 'An everyday store favorite.'
);

create table if not exists public.store_transactions (
  id text primary key,
  checkout_id text unique,
  type text not null check (type in ('sale', 'payment', 'cash_order', 'cash_in', 'cash_out')),
  status text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  description text not null,
  payment_method text not null,
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists store_transactions_created_at_idx
  on public.store_transactions (created_at desc);
create index if not exists store_transactions_type_status_idx
  on public.store_transactions (type, status);

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (char_length(username) between 1 and 80),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  token_hash text primary key,
  csrf_hash text not null,
  username text not null references public.admin_users(username) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_sessions_expires_at_idx
  on public.admin_sessions (expires_at);

create table if not exists public.admin_login_limits (
  ip_hash text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now()
);

alter table public.store_products enable row level security;
alter table public.store_transactions enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_login_limits enable row level security;

grant select, insert, update, delete on public.store_products to service_role;
grant select, insert, update, delete on public.store_transactions to service_role;
grant select, insert, update, delete on public.admin_users to service_role;
grant select, insert, update, delete on public.admin_sessions to service_role;
grant select, insert, update, delete on public.admin_login_limits to service_role;

insert into public.store_products (id, name, category, price, stock, emoji, description)
values
  ('coffee-3in1', '3-in-1 Coffee', 'Coffee & Drinks', 12, 42, '☕', 'A warm little pick-me-up for any time of day.'),
  ('coffee-premix', 'Coffee Mix', 'Coffee & Drinks', 15, 28, '🧋', 'Creamy, comforting instant coffee.'),
  ('biscuits-cream', 'Cream Biscuits', 'Biscuits & Snacks', 8, 35, '🍪', 'Crisp biscuits with a sweet cream center.'),
  ('biscuits-crackers', 'Salted Crackers', 'Biscuits & Snacks', 7, 30, '🥨', 'A crunchy merienda-time favorite.'),
  ('chips-corn', 'Corn Chips', 'Biscuits & Snacks', 10, 24, '🌽', 'Crunchy, savory chips for sharing.'),
  ('instant-noodles', 'Instant Noodles', 'Pantry Staples', 15, 36, '🍜', 'A quick and easy pantry staple.'),
  ('rice', 'Rice (per kilo)', 'Pantry Staples', 58, 80, '🍚', 'Everyday rice, sold by the kilo.'),
  ('soy-sauce', 'Soy Sauce', 'Pantry Staples', 9, 18, '🫙', 'A savory kitchen essential.'),
  ('vinegar', 'Vinegar', 'Pantry Staples', 9, 16, '🥣', 'A tangy everyday cooking staple.'),
  ('soft-drink-cola', 'Cola (bottle)', 'Soft Drinks', 22, 20, '🥤', 'Chilled and refreshing, while stocks last.'),
  ('soft-drink-orange', 'Orange Soda', 'Soft Drinks', 18, 18, '🍊', 'A bright, fizzy treat.'),
  ('candy-fruit', 'Fruit Candies', 'Biscuits & Snacks', 1, 70, '🍬', 'A little sweet treat for the road.')
on conflict (id) do nothing;

create or replace function public.store_record_login_attempt(p_ip_hash text, p_success boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
begin
  if p_success then
    delete from public.admin_login_limits where ip_hash = p_ip_hash;
    return true;
  end if;

  delete from public.admin_login_limits
  where window_started_at < now() - interval '1 day';

  insert into public.admin_login_limits as limits (ip_hash, attempts, window_started_at)
  values (p_ip_hash, 1, now())
  on conflict (ip_hash) do update
    set attempts = case
      when limits.window_started_at <= now() - interval '15 minutes' then 1
      else limits.attempts + 1
    end,
    window_started_at = case
      when limits.window_started_at <= now() - interval '15 minutes' then now()
      else limits.window_started_at
    end
  returning attempts into current_attempts;

  return current_attempts <= 8;
end;
$$;

drop function if exists public.store_restock(text, integer);
create function public.store_restock(p_product_id text, p_quantity integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_stock integer;
begin
  select stock into current_stock
  from public.store_products
  where id = p_product_id
  for update;
  if not found then
    return jsonb_build_object('error', 'That product is no longer in the inventory.', 'status', 404);
  end if;
  if current_stock + p_quantity > 100000 then
    return jsonb_build_object('error', 'Stock cannot exceed 100,000 units.', 'status', 422);
  end if;
  update public.store_products set stock = current_stock + p_quantity where id = p_product_id;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.store_record_sale(p_product_id text, p_quantity integer, p_transaction_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row public.store_products%rowtype;
begin
  select * into product_row
  from public.store_products
  where id = p_product_id
  for update;

  if not found then
    return jsonb_build_object('error', 'That product is no longer in the inventory.', 'status', 404);
  end if;
  if product_row.stock < p_quantity then
    return jsonb_build_object('error', 'There is not enough stock to record this sale.', 'status', 422);
  end if;

  update public.store_products set stock = stock - p_quantity where id = p_product_id;
  insert into public.store_transactions (id, type, status, amount, description, payment_method)
  values (
    p_transaction_id,
    'sale',
    'paid',
    round(product_row.price * p_quantity, 2),
    product_row.name || ' × ' || p_quantity,
    'Cash'
  );
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.store_resolve_cash_order(p_transaction_id text, p_cancel boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.store_transactions%rowtype;
  item jsonb;
  product_row public.store_products%rowtype;
begin
  select * into transaction_row
  from public.store_transactions
  where id = p_transaction_id and type = 'cash_order'
  for update;

  if not found then
    return jsonb_build_object('error', 'That cash order could not be found.', 'status', 404);
  end if;
  if transaction_row.status <> 'pending' then
    return jsonb_build_object('error', 'That cash order has already been updated.', 'status', 409);
  end if;

  if p_cancel then
    update public.store_transactions
    set status = 'cancelled', cancelled_at = now()
    where id = p_transaction_id;
    return jsonb_build_object('success', true);
  end if;

  for item in select value from jsonb_array_elements(transaction_row.items)
  loop
    select * into product_row
    from public.store_products
    where id = item->>'id'
    for update;
    if not found or product_row.stock < (item->>'quantity')::integer then
      return jsonb_build_object(
        'error',
        'There is not enough stock to confirm this order. Restock the items or cancel the order.',
        'status',
        409
      );
    end if;
  end loop;

  for item in select value from jsonb_array_elements(transaction_row.items)
  loop
    update public.store_products
    set stock = stock - (item->>'quantity')::integer
    where id = item->>'id';
  end loop;

  update public.store_transactions
  set status = 'paid', confirmed_at = now()
  where id = p_transaction_id;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.store_resolve_payment(p_checkout_id text, p_paid boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.store_transactions%rowtype;
  item jsonb;
  product_row public.store_products%rowtype;
  can_fulfill boolean := true;
begin
  select * into transaction_row
  from public.store_transactions
  where checkout_id = p_checkout_id
  for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if transaction_row.status <> 'pending' then
    return jsonb_build_object('found', true);
  end if;
  if not p_paid then
    update public.store_transactions set status = 'failed' where checkout_id = p_checkout_id;
    return jsonb_build_object('found', true);
  end if;

  for item in select value from jsonb_array_elements(transaction_row.items)
  loop
    select * into product_row
    from public.store_products
    where id = item->>'id'
    for update;
    if not found or product_row.stock < (item->>'quantity')::integer then
      can_fulfill := false;
    end if;
  end loop;

  if can_fulfill then
    for item in select value from jsonb_array_elements(transaction_row.items)
    loop
      update public.store_products
      set stock = stock - (item->>'quantity')::integer
      where id = item->>'id';
    end loop;
  end if;

  update public.store_transactions
  set status = case when can_fulfill then 'paid' else 'paid_stock_issue' end,
      confirmed_at = now()
  where checkout_id = p_checkout_id;
  return jsonb_build_object('found', true);
end;
$$;

revoke all on function public.store_record_login_attempt(text, boolean) from public, anon, authenticated;
revoke all on function public.store_restock(text, integer) from public, anon, authenticated;
revoke all on function public.store_record_sale(text, integer, text) from public, anon, authenticated;
revoke all on function public.store_resolve_cash_order(text, boolean) from public, anon, authenticated;
revoke all on function public.store_resolve_payment(text, boolean) from public, anon, authenticated;
grant execute on function public.store_record_login_attempt(text, boolean) to service_role;
grant execute on function public.store_restock(text, integer) to service_role;
grant execute on function public.store_record_sale(text, integer, text) to service_role;
grant execute on function public.store_resolve_cash_order(text, boolean) to service_role;
grant execute on function public.store_resolve_payment(text, boolean) to service_role;
