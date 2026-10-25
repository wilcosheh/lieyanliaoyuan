create table ly_engine (
  id integer primary key,
  state jsonb not null
);

insert into ly_engine (id, state) values (1, '{}'::jsonb);

create table ly_mcp_message (
  id bigint generated always as identity primary key,
  session_id text not null,
  device_key text,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create index ly_mcp_message_session_idx on ly_mcp_message (session_id, id);
create index ly_mcp_message_device_idx on ly_mcp_message (device_key);

create table ly_mcp_pending (
  id bigint generated always as identity primary key,
  device_key text not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create index ly_mcp_pending_device_idx on ly_mcp_pending (device_key, id);

create table ly_mcp_sub (
  device_key text primary key,
  session_id text not null,
  rpc_id text not null
);

create or replace function ly_mcp_notify()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify('mcp', new.session_id);
  return new;
end;
$$;

create trigger ly_mcp_message_notify
after insert or update of session_id on ly_mcp_message
for each row execute function ly_mcp_notify();

alter table ly_engine enable row level security;
alter table ly_mcp_message enable row level security;
alter table ly_mcp_pending enable row level security;
alter table ly_mcp_sub enable row level security;

revoke all on ly_engine from anon, authenticated;
revoke all on ly_mcp_message from anon, authenticated;
revoke all on ly_mcp_pending from anon, authenticated;
revoke all on ly_mcp_sub from anon, authenticated;
