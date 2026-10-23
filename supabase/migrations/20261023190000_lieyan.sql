create table ly_room (
  code text primary key,
  version integer not null default 1,
  phase text not null default 'lobby',
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table ly_device (
  device_id text primary key,
  room_code text,
  name text not null default ''
);

create table ly_outbox (
  id bigint generated always as identity primary key,
  device_id text not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create index ly_outbox_device_id_idx on ly_outbox (device_id, id);
create index ly_room_phase_idx on ly_room (phase);

create or replace function ly_sync_devices(p_code text, p_state jsonb)
returns void
language plpgsql
as $$
begin
  insert into ly_device (device_id, room_code, name)
  select p->>'deviceId', p_code, coalesce(p->>'name', '')
  from jsonb_array_elements(coalesce(p_state->'world'->'players', '[]'::jsonb)) as p
  on conflict (device_id) do update
    set room_code = excluded.room_code,
        name = excluded.name;

  update ly_device
  set room_code = null
  where room_code = p_code
    and device_id not in (
      select p->>'deviceId'
      from jsonb_array_elements(coalesce(p_state->'world'->'players', '[]'::jsonb)) as p
    );
end;
$$;

create or replace function ly_create(p_code text, p_state jsonb, p_outbox jsonb)
returns void
language plpgsql
as $$
begin
  insert into ly_room (code, version, phase, state)
  values (p_code, 1, coalesce(p_state->'world'->>'phase', 'lobby'), p_state);
  perform ly_sync_devices(p_code, p_state);
  insert into ly_outbox (device_id, body)
  select x->>'device_id', x->'body'
  from jsonb_array_elements(coalesce(p_outbox, '[]'::jsonb)) as x;
end;
$$;

create or replace function ly_apply(
  p_code text,
  p_expected integer,
  p_state jsonb,
  p_outbox jsonb
)
returns boolean
language plpgsql
as $$
begin
  update ly_room
  set state = p_state,
      version = p_expected + 1,
      phase = coalesce(p_state->'world'->>'phase', phase),
      updated_at = now()
  where code = p_code and version = p_expected;
  if not found then
    return false;
  end if;
  perform ly_sync_devices(p_code, p_state);
  insert into ly_outbox (device_id, body)
  select x->>'device_id', x->'body'
  from jsonb_array_elements(coalesce(p_outbox, '[]'::jsonb)) as x;
  return true;
end;
$$;

create or replace function ly_drain(p_device text)
returns jsonb
language plpgsql
as $$
declare
  rows jsonb;
begin
  delete from ly_outbox where created_at < now() - interval '10 minutes';
  with del as (
    delete from ly_outbox
    where id in (
      select id from ly_outbox
      where device_id = p_device
      order by id
      for update skip locked
    )
    returning id, body
  )
  select coalesce(jsonb_agg(body order by id), '[]'::jsonb) into rows from del;
  return rows;
end;
$$;

create or replace function ly_drain_all()
returns jsonb
language plpgsql
as $$
declare
  rows jsonb;
begin
  with del as (
    delete from ly_outbox
    where id in (
      select id from ly_outbox
      order by id
      limit 200
      for update skip locked
    )
    returning id, body
  )
  select coalesce(jsonb_agg(body order by id), '[]'::jsonb) into rows from del;
  return rows;
end;
$$;

alter table ly_room enable row level security;
alter table ly_device enable row level security;
alter table ly_outbox enable row level security;

revoke all on ly_room, ly_device, ly_outbox from public, anon, authenticated;
grant all on ly_room, ly_device, ly_outbox to service_role;
grant usage, select on sequence ly_outbox_id_seq to service_role;

revoke all on function ly_sync_devices(text, jsonb) from public, anon, authenticated;
revoke all on function ly_create(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function ly_apply(text, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function ly_drain(text) from public, anon, authenticated;
revoke all on function ly_drain_all() from public, anon, authenticated;

grant execute on function ly_sync_devices(text, jsonb) to service_role;
grant execute on function ly_create(text, jsonb, jsonb) to service_role;
grant execute on function ly_apply(text, integer, jsonb, jsonb) to service_role;
grant execute on function ly_drain(text) to service_role;
grant execute on function ly_drain_all() to service_role;
