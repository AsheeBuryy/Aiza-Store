alter table public.store_transactions
  add column if not exists gcash_reference text,
  add column if not exists receipt_path text,
  add column if not exists submission_token_hash text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gcash-payment-receipts',
  'gcash-payment-receipts',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.store_resolve_gcash_payment(p_transaction_id text, p_paid boolean)
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
  where id = p_transaction_id
    and type = 'payment'
    and payment_method = 'Manual GCash'
  for update;

  if not found then
    return jsonb_build_object('error', 'That manual GCash payment could not be found.', 'status', 404);
  end if;
  if transaction_row.status <> 'pending' then
    return jsonb_build_object('error', 'That GCash payment has already been updated.', 'status', 409);
  end if;

  if not p_paid then
    update public.store_transactions
    set status = 'cancelled', cancelled_at = now()
    where id = p_transaction_id;
    return jsonb_build_object('success', true);
  end if;

  if transaction_row.submission_token_hash is not null
      and (transaction_row.gcash_reference is null or transaction_row.receipt_path is null) then
    return jsonb_build_object(
      'error',
      'The customer has not submitted a GCash reference number and receipt yet.',
      'status',
      409
    );
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
        'There is not enough stock to confirm this payment. Restock the items or cancel the order.',
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

revoke all on function public.store_resolve_gcash_payment(text, boolean) from public, anon, authenticated;
grant execute on function public.store_resolve_gcash_payment(text, boolean) to service_role;
