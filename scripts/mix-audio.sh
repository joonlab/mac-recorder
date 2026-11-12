#!/bin/bash
# 재생용 소리 합치기 — 캡처 앱이 녹화를 마친 직후 자동으로 부른다.
#
# 녹화 파일은 시스템 소리(2ch)와 마이크(1ch)를 따로 담는다(전사 때 «나/상대» 구분용).
# 그런데 QuickTime 등 대부분의 플레이어는 첫 오디오 트랙만 재생해서 마이크가 안 들린다.
# 그래서 두 트랙을 합친 <이름>_mixed.<확장자> 를 옆에 만든다. 원본은 건드리지 않는다.
#
# 싱크: 마이크 트랙은 시스템 소리보다 조금 늦게 시작한다(실측 약 0.3초).
#   aresample=async=1:first_pts=0 이 앞을 무음으로 채워 원래 시간축을 지킨다. 빼지 말 것.
# 사용: mix-audio.sh <녹화파일>
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
log() { printf '[mix-audio] %s\n' "$*" >&2; }

src="${1:?녹화 파일 경로}"
[ -f "$src" ] || { log "없음: $src"; exit 1; }
case "$(basename "$src")" in *_mixed.*|*_all.mp4|display-*.mp4) exit 0 ;; esac
command -v ffmpeg >/dev/null || { log "ffmpeg 없음"; exit 1; }

nA=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$src" 2>/dev/null | grep -c .)
nV=$(ffprobe -v error -select_streams v -show_entries stream=index -of csv=p=0 "$src" 2>/dev/null | grep -c .)
[ "$nA" -ge 2 ] || { log "오디오 트랙 ${nA}개 — 합칠 필요 없음"; exit 0; }

base="${src%.*}"
if [ "$nV" -gt 0 ]; then ext=mp4; fmt=mp4; else ext=m4a; fmt=ipod; fi
out="${base}_mixed.${ext}"
tmp="${out}.part"

fc=""; labels=""
for ((i = 0; i < nA; i++)); do
  fc+="[0:a:${i}]aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[a${i}];"
  labels+="[a${i}]"
done
fc+="${labels}amix=inputs=${nA}:duration=longest:dropout_transition=0:normalize=0[mx];[mx]alimiter=limit=0.97[aout]"

maps=()
[ "$nV" -gt 0 ] && maps+=(-map 0:v:0 -c:v copy)
maps+=(-map "[aout]" -c:a aac -b:a 192k -ar 48000 -ac 2)

rm -f "$tmp"
if ffmpeg -y -v error -nostats -i "$src" -filter_complex "$fc" "${maps[@]}" -movflags +faststart -f "$fmt" "$tmp" </dev/null; then
  mv -f "$tmp" "$out"; log "OK $out"
else
  rm -f "$tmp"; log "FAIL $src"; exit 1
fi
