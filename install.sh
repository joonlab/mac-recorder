#!/usr/bin/env bash
# MacRecorder 설치 — 여러 번 실행해도 안전하다(업데이트도 git pull 후 이 스크립트를 다시 실행).
#
#   ./install.sh                     녹화 + 메뉴바 + 대시보드
#   ./install.sh --with-transcribe   + 로컬 전사(whisper.cpp, 모델 약 0.9GB 내려받음)
#   ./install.sh --with-claude-skill + Claude Code 스킬(~/.claude/skills/mac-recorder)
#   ./install.sh --all               위 둘 다
#   옵션: --port 7931  --recordings ~/Movies/MacRecorder  --no-menubar  --no-autostart
#
# 하는 일
#   1) 필요한 도구 확인·설치(Homebrew 로 node·ffmpeg, npm 으로 pm2)
#   2) 네이티브 앱 두 개를 이 맥에서 빌드해 ~/Applications 에 설치
#        MacRecorder.app          메뉴바 아이콘
#        MacRecorder Capture.app  녹화 엔진(권한은 이 앱에 준다)
#   3) 서버를 pm2 로 실행하고, 로그인할 때 자동으로 다시 살아나게 등록
#   4) macrec 명령을 ~/.local/bin 에 연결
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${MACREC_HOME:-$HOME/.mac-recorder}"
APPS="${MACREC_APPS:-$HOME/Applications}"   # 시험용으로 바꿀 수 있다
PM2_NAME="${MACREC_PM2_NAME:-mac-recorder}"
TEST_MODE=0; [ -n "${MACREC_APPS:-}" ] && TEST_MODE=1   # 시험 설치: 실제 앱 권한·macrec 연결·스킬은 건드리지 않는다
PORT=""; RECDIR=""
WITH_TX=0; WITH_SKILL=0; MENUBAR=1; AUTOSTART=1
while [ $# -gt 0 ]; do
  case "$1" in
    --with-transcribe) WITH_TX=1 ;;
    --with-claude-skill) WITH_SKILL=1 ;;
    --all) WITH_TX=1; WITH_SKILL=1 ;;
    --port) PORT="$2"; shift ;;
    --recordings) RECDIR="$2"; shift ;;
    --no-menubar) MENUBAR=0 ;;
    --no-autostart) AUTOSTART=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 64 ;;
  esac
  shift
done

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
step() { printf "\n${B}▶ %s${N}\n" "$*"; }
ok()   { printf "  ${G}✓${N} %s\n" "$*"; }
warn() { printf "  ${Y}!${N} %s\n" "$*"; }
die()  { printf "\n${R}✗ %s${N}\n" "$*" >&2; exit "${2:-1}"; }
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# ── 0. 이 맥이 맞는지 ──────────────────────────────────────────────
step "환경 확인"
[ "$(uname)" = Darwin ] || die "macOS 전용입니다."
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 15 ] || die "macOS 15(Sequoia) 이상이 필요합니다. 지금: $(sw_vers -productVersion)"
ok "macOS $(sw_vers -productVersion) · $(uname -m)"
case "$REPO" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
    die "이 폴더($REPO)는 macOS 보호 폴더라 백그라운드 서버가 멈출 수 있습니다.
  다른 위치로 옮겨 주세요:  git clone https://github.com/joonlab/mac-recorder.git ~/Developer/mac-recorder" ;;
esac
ok "설치 위치: $REPO"

# ── 1. 도구 ────────────────────────────────────────────────────────
step "필요한 도구"
if ! command -v brew >/dev/null; then
  die "Homebrew 가 없습니다. 터미널에서 아래를 실행한 뒤 이 스크립트를 다시 실행하세요(맥 비밀번호를 물어봅니다):
  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" 2
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

need_node=1
if command -v node >/dev/null; then
  NV="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NV" -ge 20 ] && need_node=0
fi
if [ $need_node = 1 ]; then warn "node 20 이상 설치 중…"; brew install node >/dev/null; fi
# pm2·launchd 가 쓸 node 는 셸마다 바뀌는 경로(fnm·nvm 임시 경로)가 아니라 실제 파일 경로로 고정
NODE="$(node -p 'require("fs").realpathSync(process.execPath)')"
ok "node $(node -v) ($NODE)"

if ! command -v ffmpeg >/dev/null; then warn "ffmpeg 설치 중…(몇 분 걸릴 수 있음)"; brew install ffmpeg >/dev/null; fi
ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

if ! command -v pm2 >/dev/null; then warn "pm2 설치 중…"; npm install -g pm2 >/dev/null 2>&1 || die "pm2 설치 실패. 'npm install -g pm2' 를 직접 실행해 보세요."; fi
PM2="$(command -v pm2)"
ok "pm2 $("$PM2" -v 2>/dev/null | tail -1)"

step "서버 의존성"
(cd "$REPO" && npm install --omit=dev --no-audit --no-fund --silent) && ok "npm 패키지"

# ── 2. 네이티브 앱 ─────────────────────────────────────────────────
step "앱 빌드·설치 (~/Applications)"
mkdir -p "$APPS" "$HOME_DIR/logs"
# 앱마다 따로 비교해 바뀐 앱만 교체한다. 녹화 엔진을 다시 빌드하면 서명이 바뀌어
# 화면 기록·마이크 권한을 다시 켜야 하므로, 메뉴바만 바뀐 업데이트에서는 엔진을 건드리지 않는다.
hash_of() { cat "$@" 2>/dev/null | shasum -a 256 | cut -c1-16; }
CAP_HASH="$(hash_of "$REPO"/native/capture/* "$REPO/native/assets/MacRecorderCapture.icns" "$REPO/native/build.sh")"
MENU_HASH="$(hash_of "$REPO/VERSION" "$REPO"/native/menubar/* "$REPO/native/assets/MacRecorder.icns" "$REPO/native/build.sh")"
need() { # <앱이름> <해시> → 0 이면 설치 필요
  [ ! -d "$APPS/$1.app" ] || [ "$(cat "$HOME_DIR/.build-$2" 2>/dev/null)" != "$3" ]
}
NEED_CAP=0; NEED_MENU=0
need "MacRecorder Capture" capture "$CAP_HASH" && NEED_CAP=1
need "MacRecorder" menubar "$MENU_HASH" && NEED_MENU=1
REBUILT=$NEED_CAP
if [ $NEED_CAP = 0 ] && [ $NEED_MENU = 0 ]; then
  ok "앱이 최신입니다(다시 빌드하지 않음 → 이미 준 권한 유지)"
else
  BUILD="$(mktemp -d)/build"
  if command -v swiftc >/dev/null && swiftc --version >/dev/null 2>&1; then
    "$REPO/native/build.sh" "$BUILD" >"$HOME_DIR/logs/build.log" 2>&1 || die "앱 빌드 실패(로그: $HOME_DIR/logs/build.log). 'xcode-select --install' 로 Command Line Tools 를 설치·업데이트한 뒤 다시 실행하세요."
    ok "이 맥에서 빌드함 (swiftc)"
  else
    warn "swiftc(Command Line Tools)가 없어 미리 빌드된 앱을 내려받습니다."
    VER="$(cat "$REPO/VERSION")"
    URL="https://github.com/joonlab/mac-recorder/releases/download/v$VER/MacRecorder-apps-v$VER.zip"
    mkdir -p "$BUILD"
    curl -fsSL "$URL" -o "$BUILD/apps.zip" || die "내려받기 실패: $URL
  'xcode-select --install' 로 Command Line Tools 를 설치하면 직접 빌드할 수 있습니다."
    ditto -x -k "$BUILD/apps.zip" "$BUILD" && rm -f "$BUILD/apps.zip"
    xattr -dr com.apple.quarantine "$BUILD" 2>/dev/null || true
    ok "미리 빌드된 앱 v$VER"
  fi
  place() { # <앱이름> <해시키> <해시>
    if [ -d "$APPS/$1.app" ]; then mv "$APPS/$1.app" "$HOME/.Trash/$1 $(date +%Y%m%d-%H%M%S).app"; fi  # 기존 앱은 휴지통으로
    ditto "$BUILD/$1.app" "$APPS/$1.app"
    echo "$3" > "$HOME_DIR/.build-$2"
    ok "$APPS/$1.app"
  }
  if [ $NEED_MENU = 1 ]; then pkill -x MacRecorder 2>/dev/null || true; place "MacRecorder" menubar "$MENU_HASH"; else ok "메뉴바 앱 최신"; fi
  if [ $NEED_CAP = 1 ]; then
    place "MacRecorder Capture" capture "$CAP_HASH"
    # 서명이 바뀐 앱은 예전 권한 항목이 남아 «켜도 안 되는» 상태가 된다 → 이 앱의 권한 기록만 지우고 새로 요청받는다
    if [ $TEST_MODE = 0 ]; then
      tccutil reset ScreenCapture io.github.joonlab.macrecorder.capture >/dev/null 2>&1 || true
      tccutil reset Microphone io.github.joonlab.macrecorder.capture >/dev/null 2>&1 || true
      ok "녹화 엔진 권한 기록 초기화(다른 앱 권한은 그대로)"
    fi
  else ok "녹화 엔진 최신(권한 유지)"; fi
fi

# ── 3. 설정 ────────────────────────────────────────────────────────
step "설정"
CFG="$HOME_DIR/config.json"
"$NODE" -e '
  const fs=require("fs"); const [f,port,rec,apps]=process.argv.slice(1);
  let c={}; try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
  if(port) c.port=Number(port);
  if(rec) c.recordingsDir=rec;
  if(apps) c.captureApp=apps+"/MacRecorder Capture.app";
  fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n");
' "$CFG" "$PORT" "$RECDIR" "${MACREC_APPS:-}"
PORT="$("$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||7931)}catch{console.log(7931)}' "$CFG")"
ok "설정 파일 $CFG (포트 $PORT)"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -qv node; then
  die "포트 $PORT 를 다른 프로그램이 쓰고 있습니다. ./install.sh --port 7941 처럼 다른 포트를 지정하세요."
fi

# ── 4. 로컬 전사(선택) ─────────────────────────────────────────────
if [ $WITH_TX = 1 ]; then
  step "로컬 전사 (whisper.cpp)"
  command -v whisper-cli >/dev/null || { warn "whisper-cpp 설치 중…"; brew install whisper-cpp >/dev/null; }
  ok "whisper-cli $(command -v whisper-cli)"
  mkdir -p "$HOME_DIR/models"
  fetch_model() { # <파일> <URL> <최소바이트>
    local name="$1" url="$2" min="$3"
    for d in "$HOME_DIR/models" "$HOME/.whisper"; do
      if [ -f "$d/$name" ] && [ "$(stat -f%z "$d/$name")" -ge "$min" ]; then ok "모델 있음: $d/$name"; return; fi
    done
    warn "$name 내려받는 중…"
    # 이어받기(-C -)는 쓰지 않는다: 이어받은 모델 파일이 깨져 whisper 가 죽는 사례가 있었다
    rm -f "$HOME_DIR/models/$name.part"
    curl -fL --progress-bar "$url" -o "$HOME_DIR/models/$name.part" || die "모델 내려받기 실패: $url"
    [ "$(stat -f%z "$HOME_DIR/models/$name.part")" -ge "$min" ] || die "모델 파일 크기가 이상합니다. 다시 실행하세요."
    mv "$HOME_DIR/models/$name.part" "$HOME_DIR/models/$name"
    ok "모델: $HOME_DIR/models/$name"
  }
  fetch_model ggml-large-v3-turbo-q8_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin 870000000
  fetch_model ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin 800000
fi

# ── 5. Claude Code 스킬(선택) ──────────────────────────────────────
if [ $WITH_SKILL = 1 ] && [ $TEST_MODE = 0 ]; then
  step "Claude Code 스킬"
  SK="$HOME/.claude/skills/mac-recorder"
  mkdir -p "$SK"
  sed "s#__REPO__#$REPO#g; s#__HOME__#$HOME_DIR#g" "$REPO/claude/skills/mac-recorder/SKILL.md" > "$SK/SKILL.md"
  ok "$SK/SKILL.md — Claude Code 에서 «오늘 녹화 요약해 줘»처럼 말하면 씁니다"
fi

# ── 6. macrec 명령 ─────────────────────────────────────────────────
step "macrec 명령"
mkdir -p "$HOME/.local/bin"
[ $TEST_MODE = 0 ] && ln -sf "$REPO/bin/macrec" "$HOME/.local/bin/macrec"
chmod +x "$REPO/bin/macrec"
ok "$HOME/.local/bin/macrec"
if ! grep -qs '.local/bin' "$HOME/.zshrc" 2>/dev/null && [ "$(command -v macrec)" != "$HOME/.local/bin/macrec" ]; then
  warn "~/.local/bin 이 PATH 에 없으면 ~/.zshrc 에 추가하세요:  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── 7. 서버(pm2) ───────────────────────────────────────────────────
step "서버 실행 (pm2)"
ECO="$HOME_DIR/ecosystem.config.cjs"
cat > "$ECO" <<EOF
// MacRecorder 서버 pm2 설정 — install.sh 가 만든다(손으로 고쳐도 되지만 재설치하면 덮어씀)
module.exports = { apps: [{
  name: '$PM2_NAME',
  script: '$REPO/server/index.mjs',
  interpreter: '$NODE',
  cwd: '$HOME_DIR',            // 보호 폴더(Desktop 등)를 작업 폴더로 쓰지 않는다
  env: { MACREC_HOME: '$HOME_DIR', PATH: '$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
  autorestart: true, max_restarts: 50, restart_delay: 2000,
  out_file: '$HOME_DIR/logs/server.log', error_file: '$HOME_DIR/logs/server.log', merge_logs: true, time: true,
}] };
EOF
mkdir -p "$HOME_DIR/logs"
"$PM2" delete "$PM2_NAME" >/dev/null 2>&1 || true
"$PM2" start "$ECO" >/dev/null
"$PM2" save >/dev/null
for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || die "서버가 뜨지 않았습니다. 로그: $HOME_DIR/logs/server.log"
ok "http://127.0.0.1:$PORT"

# ── 8. 로그인 시 자동 실행 ─────────────────────────────────────────
LA="$HOME/Library/LaunchAgents"
mkdir -p "$LA"
if [ $AUTOSTART = 1 ]; then
  step "로그인·재부팅 후 자동 실행"
  # pm2 를 이미 자동 실행하도록 등록해 둔 사람(pm2 startup)은 그대로 쓴다
  EXIST="$(grep -ls 'pm2 resurrect' "$LA"/*.plist 2>/dev/null | grep -v 'io.github.joonlab.macrecorder' | head -1 || true)"
  if [ -n "$EXIST" ]; then
    ok "이미 등록된 pm2 자동 실행을 함께 씁니다: $EXIST"
  else
    PL="$LA/io.github.joonlab.macrecorder.pm2.plist"
    cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.joonlab.macrecorder.pm2</string>
  <key>ProgramArguments</key><array><string>$PM2</string><string>resurrect</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/pm2-resurrect.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/pm2-resurrect.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/io.github.joonlab.macrecorder.pm2" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PL" 2>/dev/null || true
    ok "pm2 자동 실행 등록: $PL"
  fi
  if [ $MENUBAR = 1 ]; then
    PL="$LA/io.github.joonlab.macrecorder.menubar.plist"
    cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.joonlab.macrecorder.menubar</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>$APPS/MacRecorder.app</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/io.github.joonlab.macrecorder.menubar" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PL" 2>/dev/null || true
    ok "메뉴바 앱 자동 실행 등록"
  fi
fi
[ $MENUBAR = 1 ] && { open -g "$APPS/MacRecorder.app"; ok "메뉴바 아이콘 실행(화면 오른쪽 위 ◉)"; }

# ── 9. 마무리 ──────────────────────────────────────────────────────
step "권한 확인"
MACREC_HOME="$HOME_DIR" "$REPO/bin/macrec" permissions --quiet || true

cat <<EOF

${G}${B}설치 완료${N}
  대시보드   http://127.0.0.1:$PORT
  메뉴바     화면 오른쪽 위 ◉ 아이콘   ·   단축키 ⌃⌥⌘R 로 녹화 시작/정지
  명령       macrec start | stop | status | list | doctor
  녹화 폴더  $("$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.recordingsDir||"~/Movies/MacRecorder")' "$CFG")
EOF
if [ "${REBUILT:-0}" = 1 ]; then
cat <<EOF

${Y}${B}처음 한 번 권한 허용이 필요합니다${N}
  1) macrec permissions --request   (또는 대시보드 → 설정 → 권한)
  2) 뜨는 창에서 «MacRecorder Capture» 를 허용
     · 화면 및 시스템 오디오 녹음 → 켜기   · 마이크 → 허용
  3) macrec doctor 로 모두 ✅ 인지 확인
  앱을 다시 빌드하면(업데이트) 권한을 한 번 더 켜야 할 수 있습니다.
EOF
fi
