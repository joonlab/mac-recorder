# MacRecorder — 에이전트 안내

- 사용자가 설치를 부탁하면 `docs/AGENT_INSTALL.md` 절차를 따른다.
- 사용 중 문제는 `macrec doctor` 결과와 `docs/TROUBLESHOOTING.md` 로 판단한다.

## 개발할 때

- 구조는 README «구조» 절. 서버는 의존성이 `@anthropic-ai/sdk` 하나뿐인 Node(ESM)이고, 대시보드는 빌드 없는 HTML/JS 다.
- 테스트: `npm test`. 서버만 띄워 보기: `MACREC_HOME=<임시폴더> MACREC_PORT=7999 MACREC_RECORDINGS=<임시폴더> node server/index.mjs`
- `native/capture` 를 고치면 다시 빌드할 때 앱 서명이 바뀌어 화면 기록·마이크 권한을 다시 줘야 한다. 메뉴바(`native/menubar`)만 고치면 엔진은 건드리지 않는다(`install.sh` 가 앱별로 판정).
- 녹화 엔진은 반드시 `open -n` 으로 띄운다. 서버(node)가 직접 실행하면 권한이 node 에 묻는다.
- 무거운 작업(전사·AI)은 `server/job.mjs` 별도 프로세스에서 돈다. 웹서버 안에서 동기 실행하면 그동안 모든 요청이 멈춘다.
