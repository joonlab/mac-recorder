#!/bin/bash
# 여러 화면 → 나란히 합본(recording_all.mp4)
#
# ScreenCaptureKit 은 스트림 하나에 화면 하나라, «전체 화면» 녹화는 화면마다 파일이 따로 생긴다
# (주 화면 = recording.mp4 + 소리, 나머지 = display-<ID>.mp4 영상만). 원본은 그대로 두고
# 한 파일로 보고 싶을 때를 위해 가로로 이어 붙인 합본을 만든다. 소리는 재생용 합본(_mixed)이 있으면 그것을 쓴다.
# 사용: stack-displays.sh <녹화폴더>
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
log() { printf '[stack-displays] %s\n' "$*" >&2; }

DIR="${1:?녹화 폴더}"
MAIN="$DIR/recording.mp4"
OUT="$DIR/recording_all.mp4"
AUDIO_SRC="$MAIN"; [ -f "$DIR/recording_mixed.mp4" ] && AUDIO_SRC="$DIR/recording_mixed.mp4"
EXTRAS=()
for f in "$DIR"/display-*.mp4; do [ -s "$f" ] && EXTRAS+=("$f"); done
[ -f "$MAIN" ] || { log "주 화면 파일 없음"; exit 1; }
[ ${#EXTRAS[@]} -gt 0 ] || { log "추가 화면 없음"; exit 0; }

INPUTS=("$MAIN" "${EXTRAS[@]}")
H=0
for f in "${INPUTS[@]}"; do
  h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f" 2>/dev/null | head -1)
  [ -n "$h" ] && [ "$h" -gt "$H" ] && H=$h
done
[ "$H" -gt 0 ] || { log "영상 높이를 읽지 못함"; exit 1; }
H=$(( H / 2 * 2 ))

ARGS=(); FC=""; LABELS=""
for i in "${!INPUTS[@]}"; do
  ARGS+=(-i "${INPUTS[$i]}")
  FC+="[$i:v]scale=-2:${H},setsar=1,setpts=PTS-STARTPTS[v$i];"
  LABELS+="[v$i]"
done
ARGS+=(-i "$AUDIO_SRC")
AI=${#INPUTS[@]}
FC+="${LABELS}hstack=inputs=${#INPUTS[@]}[v]"

enc() {
  ffmpeg -hide_banner -loglevel error -y "${ARGS[@]}" -filter_complex "$FC" \
    -map '[v]' -map "${AI}:a:0?" "$@" -c:a aac -b:a 192k -movflags +faststart -f mp4 "$OUT.part" </dev/null
}
log "합본 시작: 화면 ${#INPUTS[@]}개, 높이 ${H}"
if enc -c:v h264_videotoolbox -b:v 8M || enc -c:v libx264 -preset veryfast -crf 23; then
  mv -f "$OUT.part" "$OUT"; log "완료 $OUT"
else
  rm -f "$OUT.part"; log "실패"; exit 1
fi
