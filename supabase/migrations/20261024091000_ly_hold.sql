create table if not exists ly_hold (
  device_id text primary key,
  until timestamptz not null
);

alter table ly_hold enable row level security;
revoke all on ly_hold from public, anon, authenticated;
grant all on ly_hold to service_role;

create or replace function ly_hold(p_device text)
returns void
language plpgsql
as $$
begin
  insert into ly_hold (device_id, until)
  values (p_device, now() + interval '130 seconds')
  on conflict (device_id) do update
    set until = excluded.until;
end;
$$;

create or replace function ly_release(p_device text)
returns void
language plpgsql
as $$
begin
  delete from ly_hold where device_id = p_device;
end;
$$;

drop function if exists ly_peek(text);

create or replace function ly_peek(p_device text, p_holder boolean default false)
returns jsonb
language plpgsql
as $$
declare
  rows jsonb;
begin
  delete from ly_outbox where created_at < now() - interval '10 minutes';
  delete from ly_hold where until < now();
  select coalesce(
    jsonb_agg(jsonb_build_object('id', id, 'body', body) order by id),
    '[]'::jsonb
  )
  into rows
  from (
    select o.id, o.body
    from ly_outbox o
    where (p_device is null or o.device_id = p_device)
      and (
        p_holder
        or not exists (
          select 1 from ly_hold h
          where h.device_id = o.device_id and h.until > now()
        )
      )
    order by o.id
    limit 50
  ) as pending;
  return rows;
end;
$$;

revoke all on function ly_hold(text) from public, anon, authenticated;
revoke all on function ly_release(text) from public, anon, authenticated;
revoke all on function ly_peek(text, boolean) from public, anon, authenticated;
grant execute on function ly_hold(text) to service_role;
grant execute on function ly_release(text) to service_role;
grant execute on function ly_peek(text, boolean) to service_role;

notify pgrst, 'reload schema';
