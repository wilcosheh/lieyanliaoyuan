-- 按设备隔离引擎快照，避免所有人挤在 id=1 串台、状态膨胀拖垮超时。
create table if not exists ly_device_engine (
  device_key text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table ly_device_engine enable row level security;
revoke all on ly_device_engine from anon, authenticated;

-- 清掉卡住的排队战报和旧全局快照，打断 ack 死循环。
truncate ly_mcp_pending;
truncate ly_mcp_sub;
truncate ly_mcp_message;
update ly_engine set state = '{}'::jsonb where id = 1;
