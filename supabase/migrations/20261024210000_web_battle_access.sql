-- Web 匹配票据、对局成员和语音命令均只允许服务端访问。
create table if not exists web_match_ticket (
  ticket_id uuid primary key default gen_random_uuid(),
  player_id text not null,
  nickname text not null check (char_length(nickname) between 1 and 20),
  status text not null check (status in ('WAITING', 'MATCHED', 'CANCELLED')),
  battle_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists web_match_ticket_active_player
  on web_match_ticket(player_id) where status in ('WAITING', 'MATCHED');
create index if not exists web_match_ticket_waiting
  on web_match_ticket(created_at) where status = 'WAITING';

create table if not exists web_battle_member (
  battle_id uuid not null,
  player_id text not null,
  nickname text not null,
  created_at timestamptz not null default now(),
  primary key (battle_id, player_id)
);

create table if not exists web_voice_command (
  battle_id uuid not null,
  command_id uuid not null,
  player_id text not null,
  round_no integer not null check (round_no > 0),
  status text not null check (status in ('RECEIVED', 'RECOGNIZED', 'SUBMITTED', 'FAILED')),
  transcript text,
  perfection integer check (perfection between 0 and 100),
  confidence_source text check (confidence_source in ('provider', 'fallback')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (battle_id, command_id),
  foreign key (battle_id, player_id) references web_battle_member(battle_id, player_id)
);

create or replace function web_join_match(p_player_id text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  own_ticket web_match_ticket;
  opponent web_match_ticket;
  new_battle_id uuid;
  matched_ids jsonb;
begin
  if char_length(trim(p_nickname)) < 1 or char_length(trim(p_nickname)) > 20 then
    raise exception 'invalid nickname';
  end if;

  perform pg_advisory_xact_lock(hashtext('web_matchmaking'));
  select * into own_ticket from web_match_ticket
    where player_id = p_player_id and status in ('WAITING', 'MATCHED')
    order by created_at desc limit 1;
  if found then
    if own_ticket.status = 'MATCHED' then
      select jsonb_agg(player_id order by created_at) into matched_ids
        from web_battle_member where battle_id = own_ticket.battle_id;
    end if;
    return jsonb_build_object('ticket', to_jsonb(own_ticket), 'matched_player_ids', matched_ids);
  end if;

  select * into opponent from web_match_ticket
    where status = 'WAITING' and player_id <> p_player_id
    order by created_at for update skip locked limit 1;
  if not found then
    insert into web_match_ticket(player_id, nickname, status)
      values (p_player_id, trim(p_nickname), 'WAITING') returning * into own_ticket;
    return jsonb_build_object('ticket', to_jsonb(own_ticket), 'matched_player_ids', null);
  end if;

  new_battle_id := gen_random_uuid();
  update web_match_ticket set status = 'MATCHED', battle_id = new_battle_id, updated_at = now()
    where ticket_id = opponent.ticket_id returning * into opponent;
  insert into web_match_ticket(player_id, nickname, status, battle_id)
    values (p_player_id, trim(p_nickname), 'MATCHED', new_battle_id) returning * into own_ticket;
  insert into web_battle_member(battle_id, player_id, nickname) values
    (new_battle_id, opponent.player_id, opponent.nickname),
    (new_battle_id, p_player_id, trim(p_nickname));
  return jsonb_build_object(
    'ticket', to_jsonb(own_ticket),
    'matched_player_ids', jsonb_build_array(opponent.player_id, p_player_id)
  );
end;
$$;

create or replace function web_voice_command_claim(
  p_battle_id uuid,
  p_command_id uuid,
  p_player_id text,
  p_round_no integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into web_voice_command(battle_id, command_id, player_id, round_no, status)
  values (p_battle_id, p_command_id, p_player_id, p_round_no, 'RECEIVED')
  on conflict (battle_id, command_id) do nothing;
  return found;
end;
$$;

alter table web_match_ticket enable row level security;
alter table web_battle_member enable row level security;
alter table web_voice_command enable row level security;
revoke all on web_match_ticket, web_battle_member, web_voice_command from public, anon, authenticated;
grant all on web_match_ticket, web_battle_member, web_voice_command to service_role;
revoke all on function web_join_match(text, text) from public, anon, authenticated;
revoke all on function web_voice_command_claim(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function web_join_match(text, text) to service_role;
grant execute on function web_voice_command_claim(uuid, uuid, text, integer) to service_role;
