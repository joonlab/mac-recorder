---
name: mac-recorder
description: MacRecorder(맥 화면·마이크·시스템 소리 녹화 도구)의 녹화를 시작·정지하고, 녹화 전사를 읽어 교정·요약·분석한다. 사용자가 "녹화 시작/정지", "방금 회의 녹화 요약해 줘", "오늘 녹화 정리", "녹화 전사에서 할 일 뽑아 줘", "지난 회의에서 ○○ 얘기한 부분 찾아 줘", "전사 오타 고쳐 줘", "교정 사전에 추가해 줘"처럼 말하면 이 스킬을 쓴다. MacRecorder 라는 이름을 말하지 않아도 맥 녹화·회의 녹화·전사 이야기면 쓴다.
---

# MacRecorder 녹화 다루기

MacRecorder 는 이 맥에서 화면·마이크·시스템 소리를 녹화하고, whisper 로 이 맥 안에서 전사한다.
이 스킬은 그 녹화를 **사용자의 Claude Code 세션에서** 정리하는 절차다. 전사 글은 이미 이 맥에 있으므로 따로 올릴 것이 없다.

- 설치 위치: `__REPO__`
- 설정·사전: `__HOME__` (config.json, glossary.json, prompts/summary.md)
- 명령: `macrec` (없으면 `__REPO__/bin/macrec`)

## 녹화 찾기

```bash
macrec list            # 최근 10개 (ID · 길이 · 전사/요약 여부 · 제목)
macrec show latest     # 가장 최근 녹화의 폴더·파일 경로
macrec show 20261112   # ID 앞부분으로 찾기 (ID 는 시작 시각. 폴더 이름은 «20261112_1500_제목» 처럼 규칙을 따른다 — 경로는 show 결과를 쓴다)
```

녹화 폴더 안 파일:
- `transcript.md` — `[MM:SS] 화자: 내용` 형식 전사(읽을 것은 이것)
- `transcript.json` — 같은 내용을 JSON 으로 나눠 담은 파일(segments: start, end, speaker, text)
- `summary.md` — 요약(있으면)
- `recording.mp4` / `recording.m4a` — 원본, `*_mixed.*` — 재생용

전사가 없으면 `macrec transcribe <ID>` 로 만들고 `macrec show <ID>` 로 끝났는지 확인한다(백그라운드 작업, 1시간 녹화에 수 분).

## 요약·분석

1. `transcript.md` 를 끝까지 읽는다. 길면 나눠 읽되 건너뛰지 않는다.
2. `__HOME__/glossary.json` 의 고유명사·교정 규칙과 `config.json` 의 `context`(사용자 맥락)를 참고한다.
3. 요약 형식은 `__HOME__/prompts/summary.md` 가 있으면 그것을, 없으면 `__REPO__/templates/summary.md` 를 따른다.
   - 첫 줄은 `# 제목`. 전사에 없는 내용은 쓰지 않는다. 중요한 발언에는 `[MM:SS]` 를 붙인다.
4. 사용자가 저장을 원하면 녹화 폴더의 `summary.md` 에 쓴다. 대시보드에 바로 보인다.
5. 사용자가 다른 형식(할 일만, 고객 요청만, 메일 초안 등)을 원하면 그 형식을 따른다.

## 교정 (다음 녹화부터 자동으로 고쳐지게)

전사를 읽다가 잘못 들은 고유명사(사람·제품·팀 이름, 기술 용어)를 발견하면:

1. 확실한 것만 «잘못 들은 말 → 맞는 말» 목록으로 사용자에게 보여 준다. 추측은 «확인 필요»로 따로 둔다.
2. 사용자가 승인한 항목을 교정 제안에 올린다:
   ```bash
   macrec glossary propose "클로드 코드" "Claude Code" --session <ID>
   ```
   사용자가 «바로 규칙으로»라고 하면 `macrec glossary rule "A" "B"`.
3. 새 고유명사는 `macrec glossary term "이름"`.
4. 규칙은 다음 녹화부터 전사 직후 자동으로 적용된다. 이미 전사된 녹화는 `macrec transcribe <ID>` 로 다시 전사하면 반영된다.

`transcript.md` 를 직접 고쳐 달라는 요청이면, 대시보드(녹화 상세 → 직접 고치기)를 안내한다. 거기서 고치면 바뀐 부분이 자동으로 교정 제안이 된다.

## 녹화 제어

```bash
macrec start                 # 설정된 기본 소스(화면·마이크 등)로 시작
macrec start --audio-only    # 소리만(m4a)
macrec start --system        # 시스템 소리(화상회의 상대 목소리) 포함
macrec pause                 # 일시정지(멈춘 동안은 화면·소리 모두 녹화 안 됨)
macrec resume                # 같은 파일에 이어서 녹화(멈춘 시간은 파일에서 빠짐)
macrec stop
macrec status
# 창·탭 따로 녹화(여러 개 동시, 녹화마다 따로 저장)
macrec windows [검색어]      # 창 목록(ID·앱·제목)
macrec start --window <ID>[,<ID>] [--mic] [--audio app|system|none]
macrec live                  # 진행 중인 창·탭 녹화
macrec pause <녹화ID> / resume <녹화ID> / stop <녹화ID|all>
```

권한 오류가 나면 `macrec permissions` → 시스템 설정에서 «MacRecorder Capture» 허용을 안내한다.
문제가 있으면 `macrec doctor` 결과를 보고 판단한다.
브라우저 탭 하나만 녹화하려면 크롬 확장을 쓴다(`macrec extension` 이 설치 순서를 보여 준다, 상세 `docs/EXTENSION.md`). 브라우저 창을 «창 녹화»하면 소리는 맥 전체 소리로 들어간다.
