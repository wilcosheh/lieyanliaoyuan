#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v supabase >/dev/null 2>&1; then
  echo "需要先安装 Supabase CLI：https://supabase.com/docs/guides/cli"
  exit 1
fi

if [ ! -f "$HOME/.supabase/access-token" ] && [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "这台机器还没有 Supabase 登录态。先执行：supabase login"
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "请设置 SUPABASE_PROJECT_REF，例如：export SUPABASE_PROJECT_REF=abcdefghijklmnop"
  exit 1
fi

supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push
if [ -n "${LINX_API_KEY:-}" ]; then
  supabase secrets set LINX_API_KEY="$LINX_API_KEY" LINX_API_BASE="${LINX_API_BASE:-https://xrobo.qiniu.com}"
fi
supabase secrets set PUBLIC_BASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/mcp"
supabase functions deploy mcp --no-verify-jwt
echo "SSE URL: https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/mcp"
