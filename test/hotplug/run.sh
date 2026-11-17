#!/bin/bash
# 모니터 꽂기·빼기 시험 — 녹화가 끊기지 않는지 확인한다.
# 가상 모니터(vdisplay)로 HDMI 연결·분리를 흉내 낸다. 실제 녹화가 3개 생긴다(끝나면 결과를 출력).
# 사용: test/hotplug/run.sh   (설치된 MacRecorder 서버가 떠 있어야 함)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.mac-recorder/config.json","utf8")).port||7931)}catch{console.log(7931)}')"
API="http://127.0.0.1:$PORT/api"
TMP="$(mktemp -d)"; VD="$TMP/vdisplay"
clang -fobjc-arc -framework Foundation -framework CoreGraphics "$HERE/vdisplay.m" -o "$VD" || exit 1
post() { curl -s -X POST -H 'Content-Type: application/json' "$API/$1" -d "${2:-{\}}"; }
plug() { "$VD" --seconds 600 --serial 4242 --id-file "$TMP/id" & VDPID=$!; for _ in $(seq 1 20); do [ -s "$TMP/id" ] && break; sleep 0.2; done; sleep 1.5; echo "  ↳ 꽂음: 화면 $(cat "$TMP/id")"; }
unplug() { kill "$VDPID" 2>/dev/null; wait "$VDPID" 2>/dev/null; rm -f "$TMP/id"; sleep 1.5; echo "  ↳ 뺌"; }
start() { R="$(post start "$1")"; ID="$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"; echo "  ● 시작 $ID  $R" | cut -c1-160; }
stop() { post stop >/dev/null; echo "  ■ 정지"; IDS+=("$ID"); sleep 8; }
IDS=()

echo "▶ 1) 전체 화면 녹화 중 외장 모니터 빼기 → 다시 꽂기"
plug; start '{"video":true,"mic":true,"system":false,"display":"all"}'; sleep 4; unplug; sleep 4; plug; sleep 4; unplug; sleep 2; stop
echo "▶ 2) 외장 모니터만 녹화 중 빼기(내장 화면으로 옮겨 계속) → 다시 꽂기(돌아옴)"
plug; start "{\"video\":true,\"mic\":true,\"system\":false,\"display\":\"$(cat "$TMP/id")\"}"; sleep 4; unplug; sleep 4; plug; sleep 4; stop; unplug
echo "▶ 3) 내장 화면만 있을 때 시작 → 녹화 중 새 모니터 꽂기 → 빼기"
start '{"video":true,"mic":true,"system":false,"display":"all"}'; sleep 3; plug; sleep 4; unplug; sleep 3; stop

sleep 15
echo; echo "▶ 결과"
for id in "${IDS[@]}"; do node "$HERE/check.mjs" "$id"; done
