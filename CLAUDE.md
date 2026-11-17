# MacRecorder — 에이전트 안내

- 사용자가 설치를 부탁하면 `docs/AGENT_INSTALL.md` 절차를 따른다.
- 사용 중 문제는 `macrec doctor` 결과와 `docs/TROUBLESHOOTING.md` 로 판단한다.

## 개발할 때

- 구조는 README «구조» 절. 서버는 의존성이 `@anthropic-ai/sdk` 하나뿐인 Node(ESM)이고, 대시보드는 빌드 없는 HTML/JS 다.
- 테스트: `npm test`. 서버만 띄워 보기: `MACREC_HOME=<임시폴더> MACREC_PORT=7999 MACREC_RECORDINGS=<임시폴더> node server/index.mjs`
- `native/capture` 를 고치면 다시 빌드할 때 앱 서명이 바뀌어 화면 기록·마이크 권한을 다시 줘야 한다. 메뉴바(`native/menubar`)만 고치면 엔진은 건드리지 않는다(`install.sh` 가 앱별로 판정).
- 녹화 엔진은 반드시 `open -n` 으로 띄운다. 서버(node)가 직접 실행하면 권한이 node 에 묻는다.
- 무거운 작업(전사·AI)은 `server/job.mjs` 별도 프로세스에서 돈다. 웹서버 안에서 동기 실행하면 그동안 모든 요청이 멈춘다.
- 녹화 엔진은 화면이 빠지거나 생겨도 녹화를 끝내지 않는다. 1초마다 화면 목록을 점검해 다시 연결한다(백그라운드 프로세스에는 macOS 화면 변경 알림이 오지 않고 NSScreen 목록도 갱신되지 않는다 — 이름은 `--list` 를 새 프로세스로 실행해 받는다).
- 모니터 관련 수정 뒤에는 `test/hotplug/run.sh` 로 꽂기·빼기 시험을 돌린다(가상 모니터 사용, 녹화 3개가 생긴다).
