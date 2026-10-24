create or replace function ly_peek(p_device text)
returns jsonb
language plpgsql
as $$
declare
  rows jsonb;
begin
  delete from ly_outbox where created_at < now() - interval '10 minutes';
  select coalesce(
    jsonb_agg(jsonb_build_object('id', id, 'body', body) order by id),
    '[]'::jsonb
  )
  into rows
  from (
    select id, body
    from ly_outbox
    where p_device is null or device_id = p_device
    order by id
    limit 50
  ) as pending;
  return rows;
end;
$$;

create or replace function ly_ack(p_ids jsonb)
returns void
language plpgsql
as $$
begin
  delete from ly_outbox
  where id in (
    select (value::text)::bigint
    from jsonb_array_elements(coalesce(p_ids, '[]'::jsonb))
  );
end;
$$;

revoke all on function ly_peek(text) from public, anon, authenticated;
revoke all on function ly_ack(jsonb) from public, anon, authenticated;
grant execute on function ly_peek(text) to service_role;
grant execute on function ly_ack(jsonb) to service_role;
