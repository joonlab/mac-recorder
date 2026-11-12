#!/usr/bin/env bash
# MacRecorder 네이티브 앱 두 개를 빌드한다.
#   MacRecorder Capture.app — 녹화 엔진(화면 없음). 서버가 `open -n` 으로 녹화마다 띄운다.
#   MacRecorder.app         — 메뉴바 앱(오른쪽 위 아이콘).
# 사용: native/build.sh [출력폴더(기본 build)] [--universal]
# 필요: Xcode Command Line Tools (swiftc). macOS 15 이상.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build}"
UNIVERSAL=0
for a in "$@"; do [ "$a" = "--universal" ] && UNIVERSAL=1; done
[ "${OUT#--}" != "$OUT" ] && OUT="$ROOT/build"
VERSION="$(cat "$ROOT/VERSION")"
mkdir -p "$OUT"

compile() { # <출력바이너리> <소스...>  (PARSE 환경변수: 메뉴바 앱은 @main 이라 -parse-as-library)
  local bin="$1"; shift
  set -- ${PARSE:-} "$@"
  if [ "$UNIVERSAL" = 1 ]; then
    swiftc -O -target arm64-apple-macos15.0 "$@" -o "$bin.arm64"
    swiftc -O -target x86_64-apple-macos15.0 "$@" -o "$bin.x86_64"
    lipo -create "$bin.arm64" "$bin.x86_64" -output "$bin"
    rm -f "$bin.arm64" "$bin.x86_64"
  else
    swiftc -O "$@" -o "$bin"
  fi
}

bundle() { # <앱이름> <실행파일이름> <소스폴더>
  local app="$OUT/$1.app" exe="$2" src="$3"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  sed "s/__VERSION__/$VERSION/g" "$src/Info.plist" > "$app/Contents/Info.plist"
  [ -f "$ROOT/native/assets/$exe.icns" ] && cp "$ROOT/native/assets/$exe.icns" "$app/Contents/Resources/AppIcon.icns"
  compile "$app/Contents/MacOS/$exe" "$src"/*.swift
  # ad-hoc 서명: 권한(TCC)이 이 앱 신원에 붙는다. 다시 빌드하면 신원이 바뀌어 권한을 다시 줘야 한다.
  codesign --force --deep --sign - --timestamp=none "$app" >/dev/null
  echo "  ✓ $app"
}

echo "▶ 네이티브 앱 빌드 (v$VERSION)"
bundle "MacRecorder Capture" MacRecorderCapture "$ROOT/native/capture"
PARSE=-parse-as-library bundle "MacRecorder" MacRecorder "$ROOT/native/menubar"
