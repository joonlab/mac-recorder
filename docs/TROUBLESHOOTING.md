# 문제 해결

먼저 `macrec doctor` 를 실행하세요. 설치·서버·권한·전사·자동 실행 상태를 한 번에 보여 줍니다.

## 권한을 켰는데 «화면 기록 권한이 없습니다»가 나온다

녹화 엔진을 다시 빌드(업데이트)하면 앱 서명이 바뀝니다. 시스템 설정 목록에는 예전 서명의 항목이 남아 있어서, 그 스위치를 켜도 새 앱에 적용되지 않습니다.

1. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음
2. «MacRecorder Capture» 를 선택하고 − 로 뺍니다
3. + 를 눌러 `~/Applications/MacRecorder Capture.app` 을 추가하고 켭니다
4. `macrec permissions` 로 확인

설치 스크립트는 엔진을 교체할 때 이 앱의 예전 권한 기록을 자동으로 정리합니다(`tccutil reset ScreenCapture io.github.joonlab.macrecorder.capture`). 그래도 남아 있으면 위 순서로 하세요.

## 메뉴바에 «서버에 연결할 수 없음»

```bash
pm2 status mac-recorder          # online 인지
pm2 restart mac-recorder
tail -50 ~/.mac-recorder/logs/server.log
```

- `pm2: command not found` → `npm install -g pm2` 후 `~/Developer/mac-recorder/install.sh` 다시 실행
- 재부팅 뒤에만 안 뜬다 → `ls ~/Library/LaunchAgents | grep -i pm2` 로 자동 실행 항목이 있는지 확인. 없으면 `install.sh` 를 다시 실행
- 포트 충돌 → `lsof -nP -iTCP:7931 -sTCP:LISTEN` 으로 확인하고 `install.sh --port 7941`

## 메뉴바 아이콘이 안 보인다

```bash
open ~/Applications/MacRecorder.app
```

메뉴바에 아이콘이 많으면 노치에 가려 안 보일 수 있습니다. 다른 메뉴바 아이콘을 ⌘ 를 누른 채 끌어 정리하거나 Bartender·Ice 같은 메뉴바 정리 앱을 쓰세요.

## 마이크 소리가 안 들어간다 / 너무 작다

- 시스템 설정 → 사운드 → 입력에서 실제로 쓰는 마이크가 선택돼 있는지 확인하세요. 에어팟이 연결돼 있으면 에어팟 마이크가 기본이 됩니다.
- 메뉴바 → «마이크 선택» 또는 대시보드 녹화 탭에서 마이크를 직접 고를 수 있습니다.
- QuickTime 으로 원본 `recording.mp4` 를 열면 첫 트랙(시스템 소리)만 재생됩니다. 두 소리를 합친 `recording_mixed.mp4` 를 여세요. 대시보드는 자동으로 합친 파일을 재생합니다.

## 화상회의 상대 목소리가 녹음되지 않는다

«시스템 소리»를 켜야 합니다(메뉴바 토글 또는 `macrec start --system`). 화면 기록 권한에 시스템 소리 녹음이 포함됩니다.

## 전사가 엉뚱한 문장을 넣는다 («시청해 주셔서 감사합니다» 등)

조용한 구간에서 whisper 가 지어내는 문장입니다. 설치 시 무음 구간 거르기 모델(VAD)을 함께 받으므로 대부분 걸러집니다. 남는 문장은 대시보드 → 교정 사전 → «버릴 문장»에 추가하세요.

## 이름·용어가 계속 틀리게 전사된다

교정 사전 탭에서 두 가지를 넣으세요.

1. «고유명사»에 맞는 표기를 넣습니다. whisper 가 전사할 때 힌트로 씁니다.
2. «교정 규칙»에 «잘못 들은 말 → 맞는 말»을 넣습니다.

이미 전사된 녹화에 반영하려면 녹화 상세에서 «다시 전사»를 누르세요.

## 전사가 느리다

whisper large-v3-turbo 는 Apple Silicon 에서 1시간 녹음에 수 분이 걸립니다. 전사·요약은 백그라운드 작업이라 대시보드를 닫아도 계속되고, 맥 전체에서 한 번에 하나씩만 실행됩니다. 진행률은 녹화 목록과 상세 화면에 보입니다.

## «Claude Code 자동 실행» 요약이 실패한다

`claude` 명령을 서버가 찾지 못했을 수 있습니다. 대시보드 설정에서 Claude Code 경로가 ✅ 인지 확인하세요. 서버는 pm2 가 실행하기 때문에 셸 설정(별칭·함수)을 읽지 않습니다. `~/.mac-recorder/config.json` 의 `ai.claudeCliPath` 에 `which claude` 결과(실제 파일 경로)를 넣은 뒤 `pm2 restart mac-recorder` 를 실행하세요.

## 모니터를 뺐더니 녹화가 끊겼다

0.2.0 부터는 모니터를 빼도 녹화가 이어집니다(README «모니터 연결·분리» 절). 0.1.0 에서는 외장 모니터가 주 디스플레이일 때 HDMI 를 빼면 녹화가 끝났습니다. 업데이트하세요.

```bash
git -C ~/Developer/mac-recorder pull && ~/Developer/mac-recorder/install.sh --all
```

녹화 엔진이 바뀌는 업데이트라 화면 기록 권한을 한 번 다시 켜야 합니다. 녹화 상세의 «녹화 중 화면 변화»에서 언제 어느 화면이 빠지고 돌아왔는지 볼 수 있습니다.

## 녹화 중 맥이 잠들었다

화면이 꺼지면 macOS 가 녹화 스트림을 끊습니다. 녹화 엔진은 녹화를 끝내지 않고 기다렸다가, 맥이 깨어나면 같은 파일에 이어서 녹화합니다(잠든 동안은 비어 있습니다). 긴 회의를 녹화할 때는 시스템 설정 → 잠금 화면에서 화면 꺼짐 시간을 늘려 두세요.

## 완전히 지우고 다시 설치

```bash
~/Developer/mac-recorder/uninstall.sh
~/Developer/mac-recorder/install.sh --all
```

녹화(`~/Movies/MacRecorder`)와 설정(`~/.mac-recorder`)은 남습니다. 설정까지 지우려면 `~/.mac-recorder` 를 휴지통으로 옮기세요.
