#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title 메뉴바 아이콘 다시 띄우기
# @raycast.mode compact
# @raycast.packageName MacRecorder
# @raycast.icon ◉
# @raycast.description MacRecorder 메뉴바 아이콘을 다시 띄웁니다(종료했거나 숨겼을 때). 단축키 ⌃⌥⌘R·⌃⌥⌘P 도 다시 동작합니다.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
macrec menubar
