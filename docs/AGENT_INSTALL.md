# AI 에이전트용 설치·업데이트 절차

- 사용자가 이 저장소 링크를 주며 «설치해 줘», «나도 쓸 수 있게 해 줘»라고 하면 이 문서를 위에서부터 따릅니다.
- «업데이트해 줘», «최신 버전으로»라고 하면 맨 아래 **«업데이트»** 절로 바로 갑니다. 이미 설치돼 있는데 설치를 부탁받은 경우도 업데이트로 처리합니다(1절의 확인 명령으로 판단).
목표: 사용자가 메뉴바 아이콘이나 ⌃⌥⌘R 로 바로 녹화를 시작할 수 있는 상태까지 만들고, 시험 녹화로 확인합니다.

## 지킬 것

- 셸 명령의 경로는 절대경로로 씁니다. `cd` 와 상대경로를 한 명령에 섞지 않습니다.
- 사용자의 파일을 지우지 않습니다. 이 도구의 제거는 `uninstall.sh` 만 씁니다.
- API 키를 대화창에 붙여 넣으라고 하지 않습니다. 키는 사용자가 대시보드 설정 화면에 직접 넣습니다.
- `tccutil reset` 은 설치 스크립트가 이 앱(`io.github.joonlab.macrecorder.capture`)에만 실행합니다. 다른 앱 권한은 건드리지 않습니다.
- 사용자가 직접 해야 하는 일(비밀번호 입력, 시스템 설정 스위치)은 무엇을 누르면 되는지 짧게 알려 주고 기다립니다.

## 1. 환경 확인

```bash
sw_vers -productVersion; uname -m; command -v brew; cat ~/.mac-recorder/install.json 2>/dev/null; readlink ~/.local/bin/macrec 2>/dev/null
```

- macOS 15 미만이면 설치할 수 없다고 알리고 멈춥니다(ScreenCaptureKit 마이크 녹음이 macOS 15 부터).
- Homebrew 가 없으면 사용자에게 아래를 실행해 달라고 합니다(맥 비밀번호를 묻습니다). Claude Code 라면 프롬프트에 `!` 를 붙여 실행하게 안내합니다.
  ```
  ! /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
  끝나면 안내에 나온 `eval "$(/opt/homebrew/bin/brew shellenv)"` 줄을 `~/.zprofile` 에 넣었는지 확인합니다.

## 2. 사용자에게 물을 것 (한 번에)

| 질문 | 선택지 | 기본 |
|---|---|---|
| 녹화한 말을 글로 받아 적을까요? (이 맥에서 처리, 모델 약 0.9GB) | 예 / 아니요 | 예 |
| 요약은 무엇으로 할까요? | 내 Claude Code 세션에서 / Claude Code 자동 실행 / OpenAI API 키 / Anthropic API 키 / 안 함 | 내 Claude Code 세션에서 |
| 기본으로 녹화할 것 | 화면+마이크 / 화면+마이크+시스템 소리(화상회의 상대 목소리) / 마이크만 | 화면+마이크 |

질문 도구(AskUserQuestion 등)가 있으면 그것으로 묻습니다.

## 3. 받기·설치

```bash
git clone https://github.com/joonlab/mac-recorder.git ~/Developer/mac-recorder
~/Developer/mac-recorder/install.sh --with-claude-skill [--with-transcribe]
```

- 전사를 원하면 `--with-transcribe` 를 붙입니다. 첫 설치는 ffmpeg·모델 내려받기로 5~10분 걸릴 수 있습니다. 명령 시간 제한을 넉넉히(10분) 잡습니다.
- 다른 위치를 원해도 `~/Desktop`·`~/Documents`·`~/Downloads` 안은 피합니다(설치 스크립트가 거부합니다).
- 포트 7931 이 이미 쓰이고 있다는 오류가 나면 `--port 7941` 처럼 바꿔 다시 실행합니다.
- 실패하면 마지막 출력과 `~/.mac-recorder/logs/build.log`(앱 빌드), `~/.mac-recorder/logs/server.log`(서버)를 읽고 [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) 에서 해당 항목을 찾습니다.

`macrec` 이 PATH 에 없으면 `~/.local/bin/macrec` 전체 경로로 씁니다.

## 4. 기본 녹화 소스 적용

2번 답에 맞춰 서버 API 로 설정합니다. 서버는 JSON 형식 요청만 받습니다.

```bash
curl -s -X PUT -H 'Content-Type: application/json' http://127.0.0.1:7931/api/config \
  -d '{"record":{"video":true,"mic":true,"system":false}}'
```

요약 방식:

```bash
# 내 Claude Code 세션에서 → "claude-code" / 자동 실행 → "claude-cli" / OpenAI → "openai" / Anthropic → "anthropic" / 안 함 → "none"
curl -s -X PUT -H 'Content-Type: application/json' http://127.0.0.1:7931/api/config -d '{"ai":{"provider":"claude-code"}}'
```

OpenAI·Anthropic 을 골랐다면 키는 사용자가 대시보드 → 설정 → «요약·교정 AI» 에 넣게 안내합니다.

## 5. 권한 허용 (사용자가 해야 함)

먼저 무엇이 뜰지 알려 줍니다.

> 곧 권한 창이 뜹니다. 마이크 창에서 «허용»을 누르고, 시스템 설정의 «화면 및 시스템 오디오 녹음» 목록에서 «MacRecorder Capture» 스위치를 켜 주세요. «종료 후 다시 열기»를 물으면 «나중에»를 눌러도 됩니다.

```bash
~/.local/bin/macrec permissions --request
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

사용자가 켰다고 하면 확인합니다.

```bash
~/.local/bin/macrec permissions
```

둘 중 하나라도 ✅ 가 아니면: 목록에 예전 항목이 남아 있을 수 있습니다. 사용자에게 «MacRecorder Capture» 를 − 로 빼고 + 로 `~/Applications/MacRecorder Capture.app` 을 다시 추가해 켜 달라고 합니다.

## 6. 시험 녹화

사용자에게 «5초 동안 아무 말이나 해 주세요»라고 알린 뒤:

```bash
~/.local/bin/macrec start --title "설치 확인"; sleep 6; ~/.local/bin/macrec stop; sleep 10; ~/.local/bin/macrec show latest
```

- `녹화` 경로의 파일이 있고 `길이` 가 5초 안팎이면 성공입니다.
- 전사를 설치했다면 20~60초 뒤 `macrec show latest` 의 `전사` 줄에 파일이 생깁니다. 내용을 읽어 사용자가 한 말이 적혔는지 확인합니다.
- 시험 녹화는 사용자가 원하면 대시보드의 «휴지통으로» 버튼으로 지울 수 있다고 알립니다.

마지막으로 `~/.local/bin/macrec doctor` 를 실행해 결과를 보여 줍니다.

## 7. 사용자에게 알려 줄 것

- 화면 오른쪽 위 **조리개 아이콘**: 녹화 시작·정지, 소스 선택, 최근 녹화
- 단축키 **⌃⌥⌘R**: 어디서든 녹화 시작·정지
- 대시보드 **http://127.0.0.1:7931**: 녹화 목록·재생·전사·요약·교정 사전·설정
- Claude Code 에서: «방금 회의 녹화 요약해 줘», «오늘 녹화에서 할 일 뽑아 줘»
- Raycast 를 쓰면: Raycast 설정 → Extensions → Script Commands → Add Directories → `<설치 위치>/raycast`
- 녹화는 `~/Movies/MacRecorder` 에 저장되고 이 맥 밖으로 나가지 않습니다. 요약 AI 를 켜면 전사 글만 그 AI 로 갑니다.
- 업데이트: Claude Code 에 «https://github.com/joonlab/mac-recorder 최신 버전으로 업데이트해 줘» 또는 터미널에서 `macrec update`
- 브라우저 탭만 녹화하려면 크롬 확장: 아래 «크롬 확장(탭 녹화) 설치 돕기»

## 업데이트

1. **설치 위치 찾기.** 아래 순서로 처음 나오는 것을 씁니다. 경로를 짐작하지 않습니다.
   ```bash
   cat ~/.mac-recorder/install.json 2>/dev/null          # "repo" 값 (0.2.0 부터 기록)
   readlink ~/.local/bin/macrec 2>/dev/null              # <설치 위치>/bin/macrec
   grep -o "script: '[^']*'" ~/.mac-recorder/ecosystem.config.cjs 2>/dev/null   # <설치 위치>/server/index.mjs
   ```
   셋 다 없으면 설치된 적이 없는 것이므로 위의 설치 절차를 따릅니다.
2. **받기 전 확인.** `git -C <설치 위치> status --short` 에 고친 파일이 있으면 사용자에게 알리고 멈춥니다(덮어쓰지 않습니다).
3. **받고 다시 설치.** 지난번과 같은 옵션(전사·스킬 등)으로 설치합니다.
   ```bash
   git -C <설치 위치> pull --ff-only
   <설치 위치>/install.sh --reuse
   ```
   0.2.0 이상이 설치돼 있으면 `~/.local/bin/macrec update` 한 줄로 같은 일을 합니다.
4. **권한.** 설치 출력에 «처음 한 번 권한 허용이 필요합니다»가 있으면 녹화 엔진이 바뀐 것입니다. 위 5절(권한 허용)과 똑같이 진행합니다. 이 문구가 없으면 권한은 그대로입니다.
5. **확인.** 6절의 시험 녹화와 `macrec doctor` 를 실행합니다.
6. **알리기.** `<설치 위치>/CHANGELOG.md` 에서 이전 버전 이후 바뀐 내용을 두세 줄로 요약해 사용자에게 알려 줍니다. 0.4.0 미만에서 올라왔으면 크롬 확장(탭 녹화)이 생겼다고 알리고, 사용자가 원하면 아래 «크롬 확장(탭 녹화) 설치 돕기»를 진행합니다.

## 크롬 확장(탭 녹화) 설치 돕기

사용자가 «크롬 확장 설치», «탭 녹화»를 부탁하면 (0.4.0 부터). 확장 설치는 브라우저 화면에서 사용자가 직접 눌러야 하므로, 에이전트는 폴더를 열고 순서를 안내합니다. 사용자 브라우저를 대신 조작하지 않습니다.

1. `~/.local/bin/macrec extension` — Finder 에 `<설치 위치>/extension` 폴더를 열고 설치 순서를 출력합니다. 출력의 순서를 그대로 보여 줍니다.
2. 사용자가 쓰는 브라우저를 물어 주소를 알려 줍니다: Chrome `chrome://extensions` · Edge `edge://extensions` · Brave `brave://extensions` · Arc `arc://extensions`. «개발자 모드» 켜기 → «압축해제된 확장 프로그램을 로드합니다» → 위 폴더.
3. 이미 설치돼 있으면(업데이트한 경우) 확장 관리 페이지에서 «MacRecorder 탭 녹화»의 새로고침(↻)을 한 번 누르라고 안내합니다.
4. 확인: 녹화할 탭에서 확장 아이콘 → «이 탭 녹화» → 몇 초 뒤 정지. `macrec list -n 1` 에 그 탭 제목으로 녹화가 생기면 됩니다. 시험 녹화는 사용자에게 지울지 물어봅니다.
5. Safari 는 확장을 쓸 수 없습니다. Safari 창은 대시보드 «창·탭 따로 녹화 → 창 고르기»로 녹화합니다(소리는 맥 전체 소리).

자세한 내용: `docs/EXTENSION.md`
