#!/bin/bash
# 리본 서버 끄기 (맥). Finder 에서 더블클릭.
cd "$(dirname "$0")" || exit 1
PORT=8765
if [ -f server/.env ]; then
  v="$(grep -E '^RIBBON_PORT=' server/.env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//; s/[[:space:]]//g')"
  PORT="${v:-8765}"
fi
PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -z "$PIDS" ]; then
  echo "포트 $PORT 에 켜진 서버가 없습니다."
else
  kill $PIDS 2>/dev/null
  sleep 1
  PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
  echo "리본 서버를 껐습니다 (포트 $PORT)."
fi
sleep 2
