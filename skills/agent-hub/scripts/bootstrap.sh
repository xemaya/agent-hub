#!/bin/bash
set -euo pipefail

HUB_URL="${AGENT_HUB_HUB_URL:-https://hub.findu.work}"
REPOSITORY_URL="${AGENT_HUB_REPOSITORY_URL:-https://github.com/xemaya/agent-hub.git}"
REPO_DIR="${AGENT_HUB_REPO_DIR:-$HOME/.agent-hub/agent-hub}"
DATA_DIR="${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
LOCAL_URL="${AGENT_HUB_CONNECTOR_URL:-http://127.0.0.1:8788}"
LOCAL_PORT="${AGENT_HUB_LOCAL_PORT:-8788}"
CONNECTOR_NAME="${AGENT_HUB_NAME:-$(hostname -s)}"
TEMP_CONNECTOR_PID=""

cleanup() {
  unset AGENT_HUB_ENROLLMENT_TOKEN
  if [[ -n "$TEMP_CONNECTOR_PID" ]]; then
    kill -TERM "$TEMP_CONNECTOR_PID" 2>/dev/null || true
    wait "$TEMP_CONNECTOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for command in curl git node pnpm unzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '缺少依赖：%s。请先安装后重新执行。\n' "$command" >&2
    exit 1
  fi
done
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '当前一键接入脚本支持 macOS Worker；Hub 可部署在 Linux。\n' >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || {
  printf '需要 Node.js 22.5 或更新版本，当前为 %s。\n' "$(node --version)" >&2
  exit 1
}

curl --fail --silent --show-error --max-time 10 "$HUB_URL/healthz" >/dev/null || {
  printf '无法连接 Hub：%s。请检查地址和网络，不需要安装或修改 Tailscale。\n' "$HUB_URL" >&2
  exit 1
}

if [[ -e "$REPO_DIR" && ! -d "$REPO_DIR/.git" ]]; then
  printf '仓库目录已存在但不是 Git 仓库，未覆盖：%s\n' "$REPO_DIR" >&2
  exit 1
fi
if [[ -d "$REPO_DIR/.git" ]]; then
  ORIGIN="$(git -C "$REPO_DIR" remote get-url origin)"
  if [[ "$ORIGIN" != "$REPOSITORY_URL" ]]; then
    printf '仓库 origin 与预期不符，未修改：%s\n' "$REPO_DIR" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
    printf '仓库存在未提交修改，未覆盖。请先处理：%s\n' "$REPO_DIR" >&2
    exit 1
  fi
  git -C "$REPO_DIR" pull --ff-only --quiet origin main
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --quiet --branch main --single-branch "$REPOSITORY_URL" "$REPO_DIR"
fi
(cd "$REPO_DIR" && pnpm install --frozen-lockfile)

connected() {
  curl --fail --silent --max-time 3 "$LOCAL_URL/local/v1/health" |
    node --input-type=module -e 'let input=""; for await (const chunk of process.stdin) input += chunk; const health=JSON.parse(input); if (!health.ok || !health.hub_connected) process.exit(1)'
}

wait_until_connected() {
  local attempt
  for attempt in {1..60}; do
    if connected 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

if connected 2>/dev/null; then
  printf '本机 Connector 已连接 Hub，保留现有服务。\n'
else
  if [[ ! -f "$DATA_DIR/credentials.json" ]]; then
    if [[ -z "${AGENT_HUB_ENROLLMENT_TOKEN:-}" ]]; then
      printf '请让管理员另行安全提供 Enrollment Token，不要发到聊天中。\n'
      printf 'Enrollment Token（输入不显示）：' >&2
      IFS= read -r -s AGENT_HUB_ENROLLMENT_TOKEN || {
        printf '\n未读取 Token。请在本机终端执行此脚本。\n' >&2
        exit 1
      }
      printf '\n' >&2
    fi
    if [[ -z "$AGENT_HUB_ENROLLMENT_TOKEN" ]]; then
      printf 'Enrollment Token 不能为空。\n' >&2
      exit 1
    fi
    export AGENT_HUB_ENROLLMENT_TOKEN
  fi
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  node "$REPO_DIR/bin/agent-hub.js" connector --hub-url "$HUB_URL" \
    --name "$CONNECTOR_NAME" --data-dir "$DATA_DIR" --local-port "$LOCAL_PORT" &
  TEMP_CONNECTOR_PID=$!
  if ! wait_until_connected; then
    printf 'Connector 未能连接 Hub。未安装新服务，请检查上面的错误。\n' >&2
    exit 1
  fi
  kill -TERM "$TEMP_CONNECTOR_PID"
  wait "$TEMP_CONNECTOR_PID" || true
  TEMP_CONNECTOR_PID=""
  unset AGENT_HUB_ENROLLMENT_TOKEN
  node "$REPO_DIR/bin/agent-hub.js" service install --hub-url "$HUB_URL" \
    --name "$CONNECTOR_NAME" --data-dir "$DATA_DIR" --local-port "$LOCAL_PORT"
  if ! wait_until_connected; then
    printf 'launchd 服务安装后未连接 Hub，请查看 ~/.agent-hub/connector.log。\n' >&2
    exit 1
  fi
fi

node "$REPO_DIR/scripts/install-local.js" --connector-data-dir "$DATA_DIR" --connector-url "$LOCAL_URL"
node "$REPO_DIR/bin/agent-hub.js" service status
node "$REPO_DIR/bin/agent-hub.js" worker list --data-dir "$DATA_DIR"
printf '\nConnector、CLI 与 Skill 已就绪。重新打开 Agent Session 后，通过 agent-hub Skill 注册数字员工。\n'
