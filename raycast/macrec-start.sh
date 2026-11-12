#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title 녹화 시작
# @raycast.mode compact
# @raycast.packageName MacRecorder
# @raycast.icon 🔴
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
macrec start
