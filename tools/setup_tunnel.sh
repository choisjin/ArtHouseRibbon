#!/bin/bash
# 맥미니에서 Cloudflare Tunnel 을 붙인다 (밖에서 https 로 리본 서버 접속). 자세한 설명은 docs/REMOTE.md
#
#   bash tools/setup_tunnel.sh
#
# 하는 일
#   1. cloudflared 로그인 여부 확인 (안 돼 있으면 브라우저를 연다 -> arthouseribbon.com 을 고른다)
#   2. 터널 'ribbon' 이 없으면 만든다
#   3. ~/.cloudflared/config.yml 을 써 준다 (있으면 백업하고 다시 쓸지 물어본다)
#   4. DNS 에 ribbon.arthouseribbon.com 을 연결한다
#   5. 시험 실행 방법을 알려 준다
set -e

HOSTNAME_="${RIBBON_HOSTNAME:-ribbon.arthouseribbon.com}"
TUNNEL="${RIBBON_TUNNEL:-ribbon}"
PORT="${RIBBON_PORT:-8765}"
CFG="$HOME/.cloudflared/config.yml"

say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$1"; }

command -v cloudflared >/dev/null || { echo "cloudflared 가 없습니다: brew install cloudflared"; exit 1; }

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "Cloudflare 로그인 (브라우저에서 arthouseribbon.com 을 고르세요)"
  cloudflared tunnel login
fi

if ! cloudflared tunnel list | awk '{print $2}' | grep -qx "$TUNNEL"; then
  say "터널 만들기: $TUNNEL"
  cloudflared tunnel create "$TUNNEL"
fi

ID="$(cloudflared tunnel list --output json | python3 -c "
import json,sys
name = sys.argv[1]
print(next((t['id'] for t in json.load(sys.stdin) if t['name'] == name), ''))" "$TUNNEL")"
[ -n "$ID" ] || { echo "터널 ID 를 찾지 못했습니다"; exit 1; }
echo "터널 $TUNNEL = $ID"

if [ -f "$CFG" ]; then
  read -r -p "$CFG 가 이미 있습니다. 새로 쓸까요? (y/N) " yn
  case "$yn" in
    [yY]*) cp "$CFG" "$CFG.bak.$(date +%s)" ;;
    *) echo "설정 파일은 그대로 둡니다"; SKIP_CFG=1 ;;
  esac
fi

if [ -z "$SKIP_CFG" ]; then
  say "설정 파일 쓰기: $CFG"
  mkdir -p "$HOME/.cloudflared"
  cat > "$CFG" <<EOF
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
ingress:
  - hostname: $HOSTNAME_
    service: http://localhost:$PORT
  - service: http_status:404
EOF
  cat "$CFG"
fi

say "DNS 연결: $HOSTNAME_"
cloudflared tunnel route dns "$TUNNEL" "$HOSTNAME_" || echo "(이미 연결돼 있으면 이 오류는 무시해도 됩니다)"

cat <<EOF

다 됐습니다. 이제:

  1. 리본 서버를 켜 두고 (start_ribbon.command), 다른 터미널에서 시험 실행:
       cloudflared tunnel run $TUNNEL
     폰에서 https://$HOSTNAME_ 이 열리면 성공입니다. Ctrl+C 로 끄세요.

  2. 잘 되면 맥이 켜질 때 자동 실행:
       sudo cloudflared service install

  3. Cloudflare 대시보드 → Zero Trust → Access 에서 이메일 허용 목록을 꼭 거세요.
     (서버에는 아직 로그인이 없습니다. docs/REMOTE.md 3번)

  4. server/.env 에 한 줄 추가하고 서버를 다시 켜세요:
       RIBBON_PUBLIC_URL=https://$HOSTNAME_
     그리고 Spotify 앱 설정의 Redirect URIs 에 추가:
       https://$HOSTNAME_/api/music/callback
EOF
