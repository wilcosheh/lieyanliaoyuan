create table if not exists ly_battle (
  battle_id text primary key,
  version bigint not null default 1 check (version > 0),
  state jsonb not null,
  controller_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state->>'battleId' = battle_id)
);

create or replace function ly_battle_create(
  p_battle_id text,
  p_state jsonb,
  p_controller_options jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
as $$
begin
  insert into ly_battle (battle_id, version, state, controller_options)
  values (p_battle_id, 1, p_state, coalesce(p_controller_options, '{}'::jsonb))
  on conflict (battle_id) do nothing;
  return found;
end;
$$;

create or replace function ly_battle_save(
  p_battle_id text,
  p_expected_version bigint,
  p_state jsonb
)
returns bigint
language plpgsql
as $$
declare
  next_version bigint;
begin
  update ly_battle
  set state = p_state,
      version = version + 1,
      updated_at = now()
  where battle_id = p_battle_id
    and version = p_expected_version
  returning version into next_version;
  return next_version;
end;
$$;

alter table ly_battle enable row level security;
revoke all on ly_battle from public, anon, authenticated;
grant all on ly_battle to service_role;

revoke all on function ly_battle_create(text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function ly_battle_save(text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function ly_battle_create(text, jsonb, jsonb) to service_role;
grant execute on function ly_battle_save(text, bigint, jsonb) to service_role;
