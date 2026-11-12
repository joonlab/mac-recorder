#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title 녹화 상태
# @raycast.mode inline
# @raycast.packageName MacRecorder
# @raycast.icon 📊
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
macrec status
