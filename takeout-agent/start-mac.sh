#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${LUMI_TAKEOUT_CHROME_PROFILE:-$HOME/Documents/Codex/LumiTakeoutChromeBridge}"
if ! curl --silent --fail --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; then
  echo "正在打开专用外卖 Chrome…"
  open -na "Google Chrome" --args \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port=9222 \
    --remote-debugging-address=127.0.0.1 \
    --no-first-run --no-default-browser-check \
    --window-size=430,900 \
    "https://h5.ele.me/msite/"
  for _ in {1..20}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:9222/json/version >/dev/null; then break; fi
    sleep 1
  done
fi
npm start
