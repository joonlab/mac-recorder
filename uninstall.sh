#!/usr/bin/env bash
# MacRecorder 제거 — 녹화 파일과 설정(~/.mac-recorder)은 남긴다(지우려면 직접 휴지통으로).
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
HOME_DIR="${MACREC_HOME:-$HOME/.mac-recorder}"
echo "▶ 서버 중지"
pm2 delete mac-recorder >/dev/null 2>&1 && pm2 save >/dev/null 2>&1; echo "  ✓ pm2 mac-recorder 제거"
echo "▶ 자동 실행 해제"
for L in io.github.joonlab.macrecorder.pm2 io.github.joonlab.macrecorder.menubar; do
  launchctl bootout "gui/$(id -u)/$L" 2>/dev/null
  [ -f "$HOME/Library/LaunchAgents/$L.plist" ] && mv "$HOME/Library/LaunchAgents/$L.plist" "$HOME/.Trash/$L.plist" && echo "  ✓ $L"
done
echo "▶ 앱 → 휴지통"
pkill -x MacRecorder 2>/dev/null
for app in "MacRecorder" "MacRecorder Capture"; do
  [ -d "$HOME/Applications/$app.app" ] && mv "$HOME/Applications/$app.app" "$HOME/.Trash/$app $(date +%s).app" && echo "  ✓ $app.app"
done
[ -L "$HOME/.local/bin/macrec" ] && rm "$HOME/.local/bin/macrec" && echo "  ✓ macrec 명령 연결 해제"
[ -d "$HOME/.claude/skills/mac-recorder" ] && mv "$HOME/.claude/skills/mac-recorder" "$HOME/.Trash/mac-recorder-skill-$(date +%s)" && echo "  ✓ Claude Code 스킬"
REC="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).recordingsDir||"")}catch{}' "$HOME_DIR/config.json" 2>/dev/null)"
cat <<MSG

제거했습니다. 남겨 둔 것:
  녹화 파일   ${REC:-$HOME/Movies/MacRecorder}
  설정·사전   $HOME_DIR
  권한 목록   시스템 설정 → 개인정보 보호 및 보안 에서 «MacRecorder Capture» 를 빼면 깨끗합니다.
MSG
