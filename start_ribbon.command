#!/bin/bash
# 리본 서버 켜기 (맥). Finder 에서 더블클릭하면 터미널 창이 열리고 서버가 켜진다.
# 끄기: 이 창에서 Ctrl+C, 또는 창 닫기, 또는 stop_ribbon.command 더블클릭.
#
# 하는 일
#   1. 최신 코드 받기 (git pull, 고친 파일이 있으면 건너뜀)   RIBBON_NO_PULL=1 이면 안 함
#   2. 클라이언트가 바뀌었으면 npm ci / npm run build
#   3. .env 가 Ollama 를 쓰면 Ollama 켜기
#   4. 같은 포트에 떠 있는 옛 서버 끄기
#   5. 서버 실행 + 브라우저로 마이크 화면 열기 (무선 마이크 수신기가 이 맥에 꽂혀 있을 때)
#      RIBBON_OPEN=admin|tv|editor|none (쉼표로 여러 개, 기본 admin. 관리자 페이지가 마이크도 받는다)

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

say_step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$1"; }
fail() {
  printf '\n\033[1;31m✖ %s\033[0m\n' "$1"
  read -r -p "Enter 를 누르면 창을 닫습니다" _
  exit 1
}

env_value() {   # server/.env 에서 RIBBON_<이름> 값 읽기 (없으면 기본값)
  local v=""
  [ -f "$ROOT/server/.env" ] && v="$(grep -E "^RIBBON_$1=" "$ROOT/server/.env" | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
  echo "${v:-$2}"
}

PORT="$(env_value PORT 8765)"
LLM="$(env_value LLM_PROVIDER mock)"
LLM_URL="$(env_value LLM_BASE_URL "")"
# 관리자 설정 탭에서 고른 대화 모델이 있으면 그것이 앞선다 (data/settings.json 의 llm)
llm_setting() {
  python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("llm") or {}).get(sys.argv[2], ""))'     "$ROOT/data/settings.json" "$1" 2>/dev/null
}
if [ -n "$(llm_setting provider)" ]; then
  LLM="$(llm_setting provider)"
  LLM_URL="$(llm_setting base_url)"
fi
OPEN="${RIBBON_OPEN:-admin}"

# ---- 1. 최신 코드 ----
if [ -z "$RIBBON_NO_PULL" ] && [ -d .git ]; then
  say_step "최신 코드 받기"
  # package-lock.json 은 npm 이 고쳐 놓을 수 있는 자동 생성 파일이라 되돌리고 받는다
  git checkout -- client/package-lock.json 2>/dev/null
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "고친 파일이 있어서 git pull 을 건너뜁니다:"
    git status --short --untracked-files=no
  else
    BEFORE="$(git rev-parse HEAD)"
    git pull --ff-only || echo "git pull 실패 (인터넷 확인). 지금 코드로 계속합니다."
    if [ "$(git rev-parse HEAD)" != "$BEFORE" ]; then
      # 이 파일도 바뀌었을 수 있으니 새 버전으로 처음부터 다시 실행한다
      echo "새 코드를 받았습니다. 새 실행 파일로 다시 시작합니다."
      RIBBON_NO_PULL=1 exec /bin/bash "$ROOT/start_ribbon.command"
    fi
  fi
fi

# ---- 2. 클라이언트 빌드 ----
command -v node >/dev/null || fail "node 가 없습니다. brew install node (docs/MACMINI_SETUP.md 1단계)"
cd "$ROOT/client" || fail "client 폴더가 없습니다"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say_step "클라이언트 패키지 설치 (npm ci)"
  npm ci || fail "npm ci 실패"
  touch node_modules
fi
if [ ! -f dist/index.html ] || [ -n "$(find src public index.html vite.config.ts package.json -newer dist/index.html -print -quit)" ]; then
  say_step "화면 빌드 (npm run build)"
  npm run build || fail "npm run build 실패"
fi

# ---- 3. 서버 준비 ----
cd "$ROOT/server" || fail "server 폴더가 없습니다"
[ -x .venv/bin/python ] || fail "server/.venv 가 없습니다. docs/MACMINI_SETUP.md 3단계대로 설치하세요"
[ -f .env ] || echo "server/.env 가 없어 모델 없이(mock) 켭니다. 실제 대화는 docs/MACMINI_SETUP.md 6단계."
BLENDER="$(env_value BLENDER_EXE "")"
if [ -z "$BLENDER" ] && [ ! -x /Applications/Blender.app/Contents/MacOS/Blender ] && ! command -v blender >/dev/null; then
  echo "주의: 블렌더가 없어 TV 가 렌더 배경 대신 실시간 3D 로 나옵니다. brew install --cask blender (docs/MACMINI_SETUP.md 5-1단계)"
fi
if [ ! -f "$ROOT/client/public/world/catalog.json" ]; then
  echo "주의: 3D 맵 파일(client/public/world)이 없습니다. Windows 에서 python tools/sync_world.py 후 커밋하세요."
fi

if [ "$LLM" = "ollama" ]; then
  if ! curl -s -m 2 http://localhost:11434/api/tags >/dev/null; then
    say_step "Ollama 켜기"
    brew services start ollama >/dev/null 2>&1 || (ollama serve >/tmp/ollama.log 2>&1 &)
    for _ in $(seq 1 20); do curl -s -m 1 http://localhost:11434/api/tags >/dev/null && break; sleep 1; done
    curl -s -m 2 http://localhost:11434/api/tags >/dev/null || echo "Ollama 가 아직 응답하지 않습니다. 답이 안 나오면 ollama serve 를 확인하세요."
  fi
elif [ "$LLM" = "mlx" ] || [ "$LLM" = "openai" ]; then
  # mlx-serve 등 OpenAI 호환 서버는 따로 켜 둔다. 여기서는 응답하는지만 본다
  [ -z "$LLM_URL" ] && [ "$LLM" = "mlx" ] && LLM_URL="http://localhost:11234/v1"
  [ -z "$LLM_URL" ] && LLM_URL="http://localhost:8080/v1"
  if curl -s -m 3 "$LLM_URL/models" >/dev/null; then
    echo "LLM 서버 응답 확인: $LLM ($LLM_URL)"
  else
    echo "주의: LLM 서버($LLM_URL)가 응답하지 않습니다. mlx-serve 가 켜져 있는지 확인하세요."
  fi
fi

# ---- 4. 옛 서버 끄기 ----
OLD="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$OLD" ]; then
  say_step "포트 $PORT 에 떠 있는 옛 서버 끄기 (pid $OLD)"
  kill $OLD 2>/dev/null
  sleep 1
  OLD="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$OLD" ] && kill -9 $OLD 2>/dev/null
fi

# ---- 5. 실행 ----
HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
say_step "리본 서버 시작"
cat <<EOF
  관리자    : http://localhost:$PORT/?mode=admin   ← 켜 두어야 리본이가 소리를 듣습니다 (설정 탭에서 마이크)
  TV(노트북): http://$HOST_NAME.local:$PORT/?mode=tv
  맵 편집기 : http://$HOST_NAME.local:$PORT/?mode=editor
  디버그    : http://$HOST_NAME.local:$PORT/?mode=debug
  끄기      : 이 창에서 Ctrl+C
EOF

if [ "$OPEN" != "none" ]; then
  (
    for _ in $(seq 1 60); do
      if curl -s -m 1 "http://localhost:$PORT/api/state" >/dev/null; then
        for m in ${OPEN//,/ }; do open "http://localhost:$PORT/?mode=$m"; done
        exit 0
      fi
      sleep 1
    done
  ) &
fi

source .venv/bin/activate
exec python -m uvicorn ribbon.main:app --host 0.0.0.0 --port "$PORT"
