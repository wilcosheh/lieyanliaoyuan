#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v supabase >/dev/null 2>&1; then
  echo "需要先安装 Supabase CLI：https://supabase.com/docs/guides/cli"
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ] && [ -f supabase/.temp/project-ref ]; then
  SUPABASE_PROJECT_REF=$(cat supabase/.temp/project-ref)
  export SUPABASE_PROJECT_REF
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "请设置 SUPABASE_PROJECT_REF，例如：export SUPABASE_PROJECT_REF=abcdefghijklmnop"
  exit 1
fi

if ! supabase projects list >/dev/null 2>&1; then
  echo "这台机器还没有 Supabase 登录态。先执行：supabase login"
  exit 1
fi

if [ -z "${MCP_CONNECTION_KEY:-}" ]; then
  echo "请设置 MCP_CONNECTION_KEY。这是灵矽 MCP 配置里的连接密钥，不代表玩家。"
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "未另外设置 DATABASE_URL。函数会使用平台注入的 SUPABASE_DB_URL，并把 6543 改成 5432 以便 LISTEN。"
fi

supabase link --project-ref "$SUPABASE_PROJECT_REF" --yes
supabase db push --linked --yes
supabase secrets set \
  PUBLIC_BASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/game/mcp" \
  MCP_CONNECTION_KEY="$MCP_CONNECTION_KEY" \
  MCP_VOICEPRINT="${MCP_VOICEPRINT:-0}"
if [ -n "${DATABASE_URL:-}" ]; then
  supabase secrets set DATABASE_URL="$DATABASE_URL"
fi
supabase functions deploy game --no-verify-jwt --yes
echo "灵矽 SSE URL:"
echo "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/game/mcp?key=${MCP_CONNECTION_KEY}"
if [ "${MCP_VOICEPRINT:-0}" = "1" ]; then
  echo "这把密钥已声明声纹，大厅可以说「两个人」。"
else
  echo "未声明声纹。同机双人请在部署前 export MCP_VOICEPRINT=1。"
fi
