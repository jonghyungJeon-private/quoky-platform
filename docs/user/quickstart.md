# Quoky Personal 빠른 시작 (v1 + v2 + v3)

이 문서는 **한 명의 소유자(owner)** 가 자기 컴퓨터에서 Quoky를 Discord 봇으로 돌려 일상 대화, 기억,
알림, 할 일과 업무 조회, 피드백, 코드 수정과 (선택) push/PR 흐름을 쓰는 방법을 설명합니다. 이 문서의 모든 환경 변수, 문구, 안내 메시지는 소스에 실제로
존재하는 값입니다 (`.env.example`, `apps/quoky/src/config.ts`, `apps/quoky/src/bootstrap-preflight.ts`,
`packages/core/src/application/`).

> Quoky Personal은 단일 소유자용입니다. 팀/호스팅 사용은 범위가 아닙니다. Personal v2에서 알림, 피드백, 할 일/업무
> 조회, 여러 파일/새 파일 변경, 브랜치 명령, 선택형 push → PR 흐름이 추가됐습니다 (8절). Personal v3에서 상시 실행
> 서비스(launchd), 기억 관리, 학습 후보/예시, 캘린더 조회와 (선택) 일정 쓰기, 첨부 파일/이미지, (선택) Jira/Slack 쓰기,
> 로컬 운영 화면이 추가됐습니다 (7절, 8절 "Personal v3 기능"). **머지와 배포는 기본으로 꺼져 있고 배포/릴리즈는 하지
> 않습니다.** 운영자용 설정(GitHub App 권한, 커넥터 자격 증명 등)은
> [`docs/uat/operator-guide.md`](../uat/operator-guide.md)를 보세요.

## 1. 준비물

| 항목 | 요구 사항 |
|---|---|
| Node.js | **>= 18.18** |
| pnpm | **10** (저장소는 `pnpm@10.32.1`을 선언) |
| 네이티브 빌드 도구 | `better-sqlite3`를 빌드할 수 있어야 함 (macOS: `xcode-select --install`, Linux: `build-essential`과 `python3`) |
| Discord 계정 | 봇을 만들 수 있는 계정과 봇을 초대할 서버 (또는 봇과의 DM) |
| Claude Code CLI | 설치 + 로그인 완료 (4절) |
| Ollama (선택) | 일상 대화를 로컬 모델로 처리하고 싶을 때 (5절) |

```sh
node --version
pnpm --version
```

## 2. Discord 애플리케이션과 봇 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 **New Application**을 만듭니다.
2. 왼쪽 **Bot** 메뉴에서 봇을 만들고 **Reset Token**으로 토큰을 발급해 안전한 곳에 둡니다. 이 값이
   `DISCORD_BOT_TOKEN`입니다. 토큰은 채팅, 커밋, 로그에 절대 붙여 넣지 마세요.
3. 같은 **Bot** 페이지의 **Privileged Gateway Intents**에서 **MESSAGE CONTENT INTENT**를 켭니다.
   이 인텐트가 꺼져 있으면 메시지 내용을 읽을 수 없어 시작이 실패합니다 (9절 참고).
4. **OAuth2 -> URL Generator**에서 아래처럼 고르고 생성된 URL로 봇을 서버에 초대합니다.
   - Scopes: `bot`
   - Bot Permissions: **View Channels**, **Send Messages**, **Read Message History**, **Send Messages in Threads**
   - 권장: **Attach Files** — 큰 코드 변경 미리보기를 `.diff` 첨부 파일로 보낼 때 필요합니다.
5. DM은 별도 초대 없이 동작하지만, 봇과 **같은 서버를 공유**하거나 **DM 창을 한 번 열어** 두어야 메시지를
   보낼 수 있습니다.

## 3. Discord 사용자 ID와 채널 ID 찾기

Discord **설정 -> 고급 -> 개발자 모드**를 켭니다.

- 내 사용자 ID: 내 이름을 우클릭 -> **사용자 ID 복사**. 17-20자리 숫자입니다.
- 채널 ID: 봇이 응답할 채널(또는 스레드의 부모 채널)을 우클릭 -> **채널 ID 복사**.

## 4. Claude Code CLI 설치와 로그인

Quoky는 API 키 없이 로컬에 설치되고 로그인된 `claude` CLI를 호출합니다. 설치 방법은 Anthropic 공식 안내를
따르고, 로그인한 뒤 확인합니다.

```sh
claude --version
```

- CLI는 `--model`, `--effort`, `--tools` 옵션을 지원해야 합니다. 이 문서는 **Claude Code 2.1.287**로
  확인했습니다. 더 오래된 버전은 업데이트하세요.
- **경고: Quoky가 실행하는 `claude`는 `HOME` 아래의 claude 로그인 정보를 그대로 씁니다.** (`ANTHROPIC_API_KEY`
  같은 셸 변수는 자식 프로세스로 전달되지 않습니다.) 구독 계정으로 로그인했는지 `claude`에서 확인하세요.
  같은 셸에서 `claude`를 직접 실행할 때 API 과금을 피하려면 아래처럼 해제하는 것도 권장합니다.

  ```sh
  env | grep ANTHROPIC | cut -d= -f1   # 이름이 보이면
  unset ANTHROPIC_API_KEY
  ```

- Quoky의 Claude 사용량은 **Claude 구독 사용 한도**에 포함됩니다. 코드 분석과 코드 리뷰는 Claude만 처리합니다.
  코드 수정은 Claude가 우선이며, Claude가 준비되지 않았을 때만 로컬 Ollama로 대체될 수 있습니다. 한도가
  빠듯하면 Ollama를 켜 두세요. 일상 대화, 요약, 문서 분석, 읽기 전용 조회는 Ollama가 준비되어 있으면 Ollama가
  먼저 처리합니다.
- **격리:** Quoky는 `claude`를 `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`로 실행합니다. 그래서 내 claude.ai 커넥터(예: Google Calendar), 사용자/프로젝트 설정, 이전 세션 기록은 Quoky가 부른 Claude에 로드되지 않습니다. 이 옵션을 지원하는 CLI 버전이 필요합니다.
- 일상 대화 중 **정책에 민감한 요청**(캘린더/메일 발송/예약/결제/문자 같은 외부 작업 요청, "이전 지시를 무시해" 같은 지시 변경, 한국어/영어가 아닌 언어)은 Ollama가 준비되어 있어도 **Claude로** 처리됩니다. 로컬 모델이 응답 정책을 잘 따르지 못했기 때문이며, 이런 턴은 Claude 구독 한도를 씁니다. Quoky는 외부 작업을 직접 할 수 없고, 했다고 말하는 답은 "하지 않았다"는 안내로 바뀝니다.
- 모델: `QUOKY_CLAUDE_MODEL` (기본 `sonnet`). 별칭 또는 전체 이름이며 CLI에 `--model`로 전달됩니다.
- effort: 설정하지 않습니다. 작업 종류(capability)에 따라 Quoky가 정한 값이 자동으로 전달됩니다.
- **바꿀 수 있는 provider (지금 기준):** 요청마다 고르지 않고, 작업 묶음마다 고릅니다. 설치 설정(`.env.local`)이
  기본이고, 실행 중에는 운영 화면(기본값)이나 채팅 명령(그 대화만)으로 바꿀 수 있습니다 (아래 "실행 중에 모델 바꾸기").

  | 작업 | 설정 | 고를 수 있는 값 | 미설정일 때 |
  |---|---|---|---|
  | 일상 대화, 요약, 문서 분석, 읽기 조회 | `QUOKY_CHAT_PROVIDER` (아래 "대화 모델 고르기") | `claude` / `codex` / `ollama` | `QUOKY_OLLAMA_ENABLED`로 결정 (`true`(기본) → `ollama`, `false` → `claude`) |
  | 코드 수정, 코드 리뷰, 설계, 정책에 민감한 대화 | 없음 (모델만 `QUOKY_CLAUDE_MODEL`) | 항상 Claude | Claude `sonnet` |
  | 이미지 분석 | `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` (5절 "이미지") | `claude` / `ollama` / `off` (Codex는 아직 없음) | `QUOKY_OLLAMA_VISION_MODEL`이 있으면 `ollama`, 없으면 `off` |
  | 기억 임베딩 | `QUOKY_EMBEDDING_ENABLED` | 로컬 Ollama만 | 꺼짐 |

  모델은 `QUOKY_CLAUDE_MODEL`(Claude), `QUOKY_CODEX_MODEL`(Codex), `OLLAMA_MODEL`(Ollama 대화)로 정합니다. 다른 클라우드
  (OpenAI API, Gemini 등)는 지금은 쓸 수 없고 새 provider adapter가 필요합니다. 소유자 서비스는 현재
  `QUOKY_OLLAMA_ENABLED=false`라 대화를 Claude가 처리합니다 (대화 내용이 Anthropic으로 전송됨).

### 대화 모델 고르기: Claude, Codex, Ollama (`QUOKY_CHAT_PROVIDER`)

일상 대화를 어느 모델이 맡을지 `.env.local`의 `QUOKY_CHAT_PROVIDER` 하나로 고릅니다 (ADR-0092 수정안, 2026-10-07).
Claude는 항상 함께 등록됩니다.

| 값 | 일상 대화·요약·문서 분석·읽기 조회 | 코드 수정·코드 리뷰·정책에 민감한 대화 | 대화 내용이 가는 곳 |
|---|---|---|---|
| `claude` | Claude | Claude | Anthropic (Claude 구독) |
| `codex` | Codex CLI (OpenAI) | Claude | 대화 계열은 OpenAI (ChatGPT 로그인), 나머지는 Anthropic |
| `ollama` | 로컬 Ollama (5절) | Claude | 대화 계열은 이 컴퓨터 안, 나머지는 Anthropic |

- **설정하지 않으면** 예전처럼 `QUOKY_OLLAMA_ENABLED`로 정해집니다: `true`(기본)이면 `ollama`, `false`이면 `claude`.
  기존 `.env.local`은 고치지 않아도 그대로 동작합니다.
- 두 값이 서로 맞지 않으면(예: `QUOKY_CHAT_PROVIDER=codex`와 `QUOKY_OLLAMA_ENABLED=true`) **`QUOKY_CHAT_PROVIDER`가
  이기고**, 시작 로그에 `CHAT_PROVIDER_OVERRIDES_OLLAMA_ENABLED` 경고가 남습니다. 시작은 계속됩니다.
- 선택한 모델이 준비되지 않았으면(로그인 안 됨, 서버 꺼짐) 그 턴은 **Claude가 대신** 답합니다.
- `.env.local`을 바꾼 뒤에는 Quoky를 재시작합니다. 시작 로그의 `chat provider selected`와 운영 화면의 공급자 패널
  (`대화 공급자 선택`)에서 설정값을 확인할 수 있습니다. 재시작 없이 바꾸려면 아래 "실행 중에 모델 바꾸기"를 쓰세요.

**Codex를 쓰려면:**

```sh
codex --version          # codex-cli 0.160.0에서 확인
codex login              # ChatGPT 계정으로 로그인
codex login status       # "Logged in using ..."이 나와야 "준비됨"
```

```sh
# .env.local
QUOKY_CHAT_PROVIDER=codex
# QUOKY_CODEX_MODEL=     # 선택. 비워 두면(줄을 지우면) Codex CLI 기본 모델
```

- **주의: `codex`를 고르면 일상 대화, 요약(업무 조회 요약 포함), 문서 분석, 첨부한 텍스트 파일 내용이 OpenAI로
  갑니다.** 소유자가 Claude와 같은 기준으로 허용한 설정입니다. 사용량은 ChatGPT 요금제 한도에 포함되고, 한도에
  걸리면 "지금은 AI를 사용할 수 없어요"로 답합니다. 비밀처럼 보이는 첨부 내용은 어느 모델로든 보내기 전에 걸러집니다.
- **격리:** Quoky는 `codex exec`를 빈 임시 폴더에서 `--sandbox read-only`, 승인 `never`, `--ignore-user-config`,
  `--ignore-rules`, `--ephemeral`로 실행하고 셸·웹 검색·MCP·플러그인·스킬·AGENTS.md를 끕니다. 질문은 명령줄이 아니라
  표준 입력으로 전달하고, 답은 마지막 응답 메시지만 씁니다. 명령 실행이나 파일 변경을 시도한 답은 버립니다.
  내 `~/.codex/config.toml` 설정(MCP 서버 등)은 읽지 않지만, 로그인 정보와 Codex 자체 기본 지시문은 `~/.codex`와
  CLI에서 옵니다.
- 실측(2026-10-07, 기본 모델): 짧은 한국어 추천 질문 한 번에 약 7.5-8초, 준비 확인(`codex login status`)은 0.2초 이하.

### 실행 중에 모델 바꾸기 (채팅 명령과 운영 화면, ADR-0092/ADR-0111 개정)

재시작 없이 대화 모델과 이미지 모델을 바꿀 수 있습니다. 바꿀 수 있는 것은 **대화 계열**(일상 대화, 요약, 문서 분석,
읽기 조회)과 **이미지 분석**뿐입니다. 코드 수정, 코드 리뷰, 설계, 프로젝트 분석, 테스트, 정책에 민감한 대화는 언제나
Claude(`QUOKY_CLAUDE_MODEL`)가 맡습니다. 요청 하나하나마다 모델을 고르는 기능은 없습니다.

**어떤 값이 이기나 (우선순위, 높은 것부터)** — 대화와 이미지 각각 따로 정해집니다.

1. **이 대화의 변경** — 채팅 명령 `모델 변경: …` (그 대화에서 명령을 보낸 사람에게만, `새 대화`를 하면 사라짐. 같은 채널에 소유자가 여럿이면 각자 따로)
2. **운영 화면 기본값** — 운영 화면에서 고른 값 (다시 시작해도 유지, DB 옆 `ops/provider-selection.json`, 모드 600)
3. **설정** — `.env.local`의 `QUOKY_CHAT_PROVIDER` / `QUOKY_IMAGE_UNDERSTANDING_PROVIDER`
4. **기본값** — 설정이 없을 때의 예전 규칙 (`QUOKY_OLLAMA_ENABLED`, `QUOKY_OLLAMA_VISION_MODEL`)

고른 모델이 준비되지 않았으면(로그인 안 됨, 서버 꺼짐) 그 턴은 Claude가 대신 답하고, `모델 상태`가 그렇게 알려 줍니다.
이 컴퓨터에서 쓸 수 없는 선택(예: Codex CLI가 없음)은 건너뛰고 다음 순위를 씁니다. 운영 화면 기본값 파일이 깨졌거나
읽을 수 없으면 무시하고 설정값을 씁니다(시작은 계속).

**고를 수 있는 모델**

| 선택 | 쓰는 모델 | 등록 조건 | 내용이 가는 곳 |
|---|---|---|---|
| `claude` / `claude:sonnet` / `claude:opus` / `claude:haiku` | Claude CLI (별칭만 허용; `QUOKY_CLAUDE_MODEL` 값은 그 이름으로도 고를 수 있음) | 항상 | Anthropic |
| `codex` | Codex CLI (`QUOKY_CODEX_MODEL` 또는 CLI 기본 모델, 다른 모델은 고를 수 없음) | `codex` CLI가 있을 때(또는 설정·기본값이 codex일 때) | OpenAI (ChatGPT 로그인) |
| `ollama` / `ollama:<모델>` | 로컬 Ollama (`ollama list`에 있는 로컬 모델만, `cloud` 모델 제외; `ollama show`의 기능에 `completion`이 없는 모델(예: 임베딩 전용 `nomic-embed-text`)도 제외. `ollama show`로 확인하지 못하면 이름에 `embed`가 든 모델만 제외; 고를 때 목록과 대조) | `OLLAMA_MODEL`이 설정되고 `ollama` CLI가 있을 때(다른 모델은 CLI만 있으면) | 이 컴퓨터 안 |
| 이미지 `claude` | Claude CLI 비전 (`QUOKY_IMAGE_UNDERSTANDING_MODEL` 또는 `QUOKY_CLAUDE_MODEL`) | 항상 | **첨부 이미지가 Anthropic으로 전송** |
| 이미지 `ollama` | 로컬 비전 모델 (`QUOKY_OLLAMA_VISION_MODEL`) | 그 값이 설정되어 있을 때 | 이 컴퓨터 안 |
| 이미지 `off` | 없음 | 항상 | 어디로도 보내지 않음. 이미지를 보내면 "이미지 분석이 꺼져 있다"는 안내와 다시 켜는 방법(`이미지 모델 변경: claude`, `모델 기본값으로`)을 답함 |

Ollama 모델은 등록만으로는 메모리에 올라가지 않고, 실제로 답할 때만 실행됩니다. 이미지를 Anthropic으로 보내는 것은
**지금 적용되는 이미지 선택이 `claude`일 때만**이고, `ollama`나 `off`로 바꾸면 다음 이미지부터 바로 보내지 않습니다.

**채팅 명령** (소유자만, AI를 부르지 않음)

| 보낼 말 | 하는 일 |
|---|---|
| `모델 상태` 또는 `/model status` | 이 대화에 지금 적용되는 대화·이미지 모델, 출처(이 대화/운영 화면/설정/기본값), 준비 상태, 기본값 |
| `모델 목록` 또는 `/model` | 고를 수 있는 대화 모델과 이미지 선택을 번호와 준비 상태와 함께 보여 줌 (번호는 그 대화에서 30분 동안 유효) |
| `모델 변경: codex`, `모델 변경: 2`, `/model claude:opus`, `/model ollama:granite3.3:8b` | **이 대화에서만** 대화 모델을 바꿈 ("이 대화에서만 적용돼요 (기본값은 운영 화면에서).") |
| `이미지 모델 변경: ollama`, `/model image off` | 이 대화에서만 이미지 모델을 바꿈 |
| `모델 기본값으로` 또는 `/model reset` | 이 대화의 변경(대화·이미지)을 지움. `이미지 모델 기본값으로`는 이미지만 |

`모델 변경해야 할까?`처럼 명령 형식이 아닌 말은 평소 대화로 갑니다. 승인이 대기 중일 때는 승인 흐름이 먼저입니다.
잘못된 이름이나 이 컴퓨터에서 쓸 수 없는 모델은 바꾸지 않고 이유를 알려 줍니다.

**운영 화면** (아래 "운영 화면"을 켠 경우) — 공급자 패널의 **모델 기본값 바꾸기**에서 대화 모델과 이미지 모델의
기본값을 고릅니다. 지금 기본값과 출처, 준비 상태, 대화별로 바꾼 대화 수가 보이고, `설정 기본값으로 되돌리기`로
`.env.local` 값으로 돌아갑니다. 이미지 `claude`에는 "이 선택은 첨부 이미지를 이 컴퓨터 밖(Anthropic)으로 보내요."
경고가 붙습니다. 바꾸면 바로 적용되고(대화별로 바꾼 대화는 그대로), 소유자 DM으로 "운영 화면에서 대화 모델을
codex로 바꿨어요" 같은 알림이 한 번 갑니다. 모든 변경은 `provider.selection.changed` 로그(누가, 어디서, 무엇을;
내용 없음)로 남습니다.

## 5. Ollama (선택, 기본 사용)

일상 대화(`GENERAL_CHAT`)는 **로컬 Ollama가 준비되어 있으면 Ollama가 먼저** 처리하고, 준비되지 않았으면
**자동으로 Claude로 대체**됩니다. Ollama를 쓰지 않으려면 `.env.local`에 `QUOKY_OLLAMA_ENABLED=false`를
넣으세요 (기본값은 `true`). 코드 분석/리뷰는 이 설정과 상관없이 Claude가 처리합니다. `QUOKY_OLLAMA_ENABLED=true`(기본)이면 요약·문서 분석·읽기 조회도 Ollama가 우선이고, 코드 수정은 Claude가 준비되지 않았을 때 Ollama로 대체될 수 있습니다. 코드 수정을 항상 Claude로만 하려면 `QUOKY_OLLAMA_ENABLED=false`.

```sh
ollama --version
ollama pull llama3.1            # OLLAMA_MODEL 기본값
# v3 측정에서 고른 모델 (아래 설명):
ollama pull granite3.3:8b       # 그리고 .env.local에 OLLAMA_MODEL=granite3.3:8b
```

- **모델 선택 (v3 LLM-2 측정):** 답변 품질 하네스(도움이 되는 답인지 보는 검사 포함)로 비교했을 때 `granite3.3:8b`가 가장
  좋았습니다(관련 내용 9/10, 확인할 수 없는 것을 얼버무리지 않고 밝힘 3/4, 지어낸 구체 정보 없음 4/4, 답변 언어 일치
  96.9%). `gemma3:4b`는 정책 검사는 통과했지만 실제 대화에서 "도움말을 확인해보세요" 같은 답만 해서 쓰지 않습니다.
  소유자 Mac(M3 Pro, 18GB)에서 `granite3.3:8b`는 약 5.7GB, GPU 100%, 초당 15-17 토큰, 처음 불러올 때 약 16초입니다.
  `OLLAMA_MODEL`의 코드 기본값은 여전히 `llama3.1`이고, 바꾸는 것은 운영자 설정입니다. 부하가 내려간 뒤 한
  재검증(W6-M5)은 **부분 통과**입니다: 4개 중 3개를 granite가 답했고(생성 21-38초), 1개는 동시에 돈 테스트로 부하가
  다시 올라 Claude로 대체되었습니다. 노래·가수 이름을 지어내는 문제는 남아 있어, 로컬 모델은 구체적인 사실을 지어낼 수
  있습니다. 한국어 일상 대화 20문항 세트는 아직 하지 않았습니다. 답이 단어 중간에서 끊기던 문제는 고쳤습니다(PR #133).
- **이미지 (선택):** 이미지를 읽는 provider는 `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` 하나로 고릅니다 (ADR-0111 개정, 2026-10-07).
  - `ollama` — 로컬 비전 모델. 모델을 받고 `QUOKY_OLLAMA_VISION_MODEL`에 이름을 적습니다 (예: `gemma3:4b`처럼 이미지 입력을
    지원하는 모델). 이미지는 이 컴퓨터를 떠나지 않습니다. 이름에 `cloud`가 들어간 모델은 거부합니다.
  - `claude` — Claude CLI가 이미지를 읽습니다. **첨부 이미지가 Anthropic(클라우드)으로 전송됩니다.** 모델은
    `QUOKY_IMAGE_UNDERSTANDING_MODEL`, 없으면 `QUOKY_CLAUDE_MODEL`, 없으면 `sonnet`. 대화용 Claude와 같은 격리 옵션으로
    실행하고 도구는 모두 끕니다. 이미지는 파일 경로가 아니라 표준 입력의 이미지 블록으로 보냅니다 (`claude`만 해당. `ollama`는 임시 파일 경로를 `ollama run` 인자로 넘깁니다). Claude CLI가 설치되고
    로그인되어 있어야 "준비됨"입니다 (`claude auth status`).
  - `off` — 이미지 분석을 쓰지 않습니다.
  - **설정하지 않으면** 예전과 같습니다: `QUOKY_OLLAMA_VISION_MODEL`이 있으면 `ollama`, 없으면 `off`. 이때는 이미지 바이트가
    클라우드로 가지 않습니다.
  - 준비된 provider가 없으면 이미지는 분석하지 않고 어디로도 보내지 않았다고 답합니다.
  - **`claude`를 고를 때 알아 둘 점:** 이미지 **안에** 보이는 비밀번호·토큰 같은 비밀값은 보내기 전에 찾아낼 수 없습니다
    (이미지 내용은 검사하지 않음). 비밀값이 보이는 스크린샷은 올리지 마세요. 함께 적은 글(캡션)과 첨부한 텍스트 파일은
    보내기 전에 비밀값 검사를 거치고, 답에 비밀값처럼 보이는 내용이 있으면 답 전체를 보여 주지 않고 저장하지도 않습니다.

- **Ollama 서버가 실행 중**이어야 하고, `OLLAMA_MODEL`로 지정한 모델이 로컬에 있어야 "준비됨"으로 봅니다.
  준비 여부는 요청 시점에 확인하며(`ollama list`, "준비됨" 결과는 약 30초 캐시), 나중에 서버를 켜거나 모델을 받아도
  재시작 없이 반영됩니다. "준비 안 됨"이면 30초, 60초, 120초(최대) 간격으로 다시 확인하고, 이 확인은 한 턴을 최대
  0.5초만 기다리게 합니다(Ollama가 꺼져 있을 때 `ollama` CLI는 앱을 띄우려고 약 5초를 기다리기 때문). 다시 준비되면
  로그에 `provider became ready`가 한 번 남습니다.
- 모델 이름은 태그까지 정확히 맞아야 합니다. 예를 들어 `ollama list`에 `llama3.1:8b`만 있는데
  `OLLAMA_MODEL=llama3.1`(태그 없음)이면 준비되지 않은 것으로 보므로 `OLLAMA_MODEL=llama3.1:8b`처럼 그대로 적으세요.
- 팁 — 아래는 **Ollama 서버 쪽 환경 변수**입니다 (Quoky의 `.env.local`이 아니라 `ollama serve`를 실행하는
  환경에 설정).
  - `OLLAMA_KEEP_ALIVE`: 모델을 메모리에 얼마나 두는지. 짧게(예: `5m`) 두면 RAM을 더 빨리 돌려받습니다.
  - `OLLAMA_CONTEXT_LENGTH`: 컨텍스트 창 크기(예: `8192`). Ollama 서버는 기본적으로 모델(`llama-server`)을
    **4096 토큰** 창으로 실행하는데, Quoky의 기본 컨텍스트 예산은 약 6000 토큰
    (`QUOKY_CONTEXT_MAX_TOKENS`, 기본 6000)이라 그대로 두면 기억/이전 대화가 잘릴 수 있습니다.
    `OLLAMA_CONTEXT_LENGTH=8192`로 서버를 띄우거나, Quoky 쪽 `QUOKY_CONTEXT_MAX_TOKENS`를 4096보다 충분히 낮게
    설정하세요.

  ```sh
  OLLAMA_KEEP_ALIVE=5m OLLAMA_CONTEXT_LENGTH=8192 ollama serve
  ```

## 6. 설정 파일 만들기

```sh
cp -n .env.example .env.local     # 이미 있으면 덮어쓰지 않음
```

`.env.local`에서 최소한 아래 세 값을 채웁니다. 이 파일은 Git에 커밋하지 않습니다.

```sh
DISCORD_BOT_TOKEN=<2절에서 발급한 토큰>
QUOKY_DISCORD_OWNER_IDS=<내 사용자 ID>          # 필수. 쉼표로 여러 명 가능
QUOKY_DISCORD_CHANNEL_IDS=<채널 ID>             # 선택. 비우면 소유자 DM만
```

`.env.example`에는 `QUOKY_DISCORD_CHANNEL_IDS=`가 빈 값으로 들어 있습니다. 이 줄에 채널 ID를 넣으세요. 줄 앞에
`#`을 붙이거나 비워 두면 소유자 DM만 동작하고, 채널 메시지는 답 없이 무시됩니다.

| 변수 | 설명 |
|---|---|
| `DISCORD_BOT_TOKEN` | 필수. Discord 봇 토큰 |
| `QUOKY_DISCORD_OWNER_IDS` | 필수. 쉼표로 구분한 Discord **사용자** ID (각 17-20자리). 비어 있거나 형식이 틀리면 시작 실패. 소유자가 아닌 사람의 메시지는 **답장 없이 무시** |
| `QUOKY_DISCORD_CHANNEL_IDS` | 선택. 쉼표로 구분한 **채널** ID. 목록의 채널(또는 그 채널의 스레드)에서 소유자 메시지를 처리. 비우면 소유자 DM만. @멘션은 필요 없음 |
| `DISCORD_GUILD_ID` | 선택. 특정 서버만 허용 |
| `QUOKY_CHAT_PROVIDER` | 선택. `claude` / `codex` / `ollama` 정확히 이 값만 (4절 "대화 모델 고르기"). 미설정이면 `QUOKY_OLLAMA_ENABLED`로 결정 |
| `QUOKY_CODEX_MODEL` | 선택. `codex`일 때 쓸 모델. 미설정이면 Codex CLI 기본 모델 |
| `QUOKY_OLLAMA_ENABLED` | 선택. `true`(기본) / `false` 정확히 이 두 값만. `QUOKY_CHAT_PROVIDER`가 있으면 그 값이 우선 |
| `OLLAMA_MODEL` | 선택. 기본 `llama3.1` |
| `QUOKY_CLAUDE_MODEL` | 선택. 기본 `sonnet` |
| `QUOKY_GIT_REMOTE_ENABLED` | 선택. 기본 `false`. `true`면 push → PR 흐름 사용 가능 (8절 "push와 PR" 참고). 운영자 설정은 운영자 가이드 참고 |
| `QUOKY_CONTEXT_MAX_TOKENS` | 선택. 대화 한 턴에 넣는 기억/문맥의 추정 토큰 예산. 기본 6000, 최대 200000 |
| `QUOKY_GIT_MERGE_ENABLED` | 선택. 기본 `false`. `true`는 `QUOKY_GIT_REMOTE_ENABLED=true`가 필요 (아니면 `GIT_MERGE_REQUIRES_REMOTE`로 시작 실패). 머지는 별도 승인 단계이며 기본은 꺼짐. `PR 머지해줘`는 꺼져 있으면 "병합은 이 설정에서 꺼져 있어요"로 거절 |
| `QUOKY_WORK_SUMMARY_ENABLED` | 선택. 기본 `true`. 업무 조회 결과를 모델이 요약(항목이 있을 때). Ollama가 준비되지 않으면 요약이 Claude로 갈 수 있어 사내 커넥터 텍스트가 구독을 통해 이 컴퓨터 밖으로 나갈 수 있음. 정책상 불가하면 `false` |
| `QUOKY_REMINDERS_ENABLED` | 선택. 기본 `true` (ADR-0102 D9, 소유자 결정 8). `false`면 알림 기능을 끔. 꺼져 있으면 알림 문구에 "알림 기능이 꺼져 있어요. 켠 뒤에 다시 요청해 주세요."라는 고정 답만 나가고 알림은 전달되지 않음 |
| `QUOKY_REMINDERS_CHANNEL_DELIVERY` | 선택. 기본 `false` = 알림은 소유자 DM으로만 전달. **`true`면 알림을 만든 채널에 보내므로 그 채널의 모든 멤버가 알림 내용을 읽을 수 있음.** 알림이 꺼져 있으면 효과 없음. 일일 브리핑은 항상 DM |
| `QUOKY_TIMEZONE` | 선택. 기본 `Asia/Seoul`. IANA 시간대, 잘못된 값은 시작 실패 |
| `QUOKY_EMBEDDING_ENABLED` | 선택. 기본 `false`. `true`면 기억 회상을 **로컬** Ollama 임베딩으로 재정렬 (실패하면 기존 방식). 모델은 자동으로 받지 않음: 먼저 `ollama pull nomic-embed-text` |
| `QUOKY_EMBEDDING_MODEL` | 선택. 기본 `nomic-embed-text`. 이름 또는 태그에 `cloud`가 들어가면 거부 |
| `QUOKY_EMBEDDING_TIMEOUT_MS` | 선택. 기본 `3000`, 범위 100-30000. 임베딩 모델은 `--keepalive 30m`으로 메모리에 두고, 준비될 때와 시간 초과 뒤에 백그라운드에서 미리 불러옵니다(최대 30초). 실측: 이미 올라와 있으면 0.05-0.12초, 새로 불러오면 0.35-0.9초 |
| `QUOKY_MEMORY_ARCHIVE_DAYS` | 선택. 기본 `7`. 잊은 기억을 보관함에 두는 일수(0-365의 정수). 지나면 매일 정리 작업이 완전히 지움. `0`이면 보관하지 않고 바로 완전히 지움. 빈 값이나 범위 밖 값은 시작 실패(`MEMORY_ARCHIVE_DAYS_INVALID`) |
| `QUOKY_LEARNING_EXAMPLES_ENABLED` | 선택. 기본 `false`. `true`면 소유자가 저장한 예시(최대 2개)를 **로컬 실행 provider**(Ollama)의 일반 대화 프롬프트에만 넣음. Claude에는 넣지 않음 |
| `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` | 선택. `ollama` / `claude` / `off` 정확히 이 세 값만 (5절 "이미지"). 미설정이면 `QUOKY_OLLAMA_VISION_MODEL`이 있을 때 `ollama`, 없으면 `off`. **`claude`는 첨부 이미지를 Anthropic(클라우드)으로 보냄.** 다른 값은 시작 실패(`IMAGE_UNDERSTANDING_PROVIDER_INVALID`) |
| `QUOKY_IMAGE_UNDERSTANDING_MODEL` | 선택. `claude`일 때만 읽음. 이미지용 Claude 모델 (없으면 `QUOKY_CLAUDE_MODEL`, 그다음 `sonnet`). 형식이 틀리면 시작 실패 |
| `QUOKY_OLLAMA_VISION_MODEL` | 선택. 기본 없음. 이미지 분석용 로컬 Ollama 비전 모델 이름(5절). `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=ollama`이면 필수이고 없거나 잘못됐거나 `cloud` 모델이면 시작 실패. 선택값을 설정하지 않은 경우(예전 방식)에는 잘못된 값이나 `cloud` 모델이면 이미지 분석만 꺼지고 시작은 계속 |
| `QUOKY_CALENDAR_GOOGLE_CLIENT_ID`, `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET` | 선택. Google Calendar 읽기용 OAuth "Desktop app" 클라이언트 (8절 "캘린더 설정") |
| `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE` | 선택. 동의 도구가 만든 refresh token 파일 경로(모드 600). 또는 `QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN`(둘 다 넣으면 캘린더 미등록). 클라이언트 ID/비밀과 토큰이 모두 있어야 캘린더가 켜짐 |
| `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` | 선택. 기본 `primary`. 읽을 캘린더 ID (쉼표, 최대 10개) |
| `QUOKY_CALENDAR_WRITE_ENABLED` | 선택. 기본 `false`. `true`면 **기본(primary) 캘린더**에 일정 추가/변경/삭제를 승인 후 실행. `calendar.events` 권한이 든 토큰 파일 필요. 참석자 없음, 초대 메일 없음 |
| `QUOKY_CONNECTOR_WRITES_ENABLED` | 선택. 기본 `false`. Jira/Slack 쓰기 전체 스위치 |
| `QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS` | 선택. 댓글/상태 변경을 허용할 Jira 프로젝트 키 (쉼표, 최대 50개, 예: `PROJ,TEST`). Jira 읽기 자격 증명을 그대로 씀 |
| `QUOKY_CONNECTOR_WRITE_SLACK_TOKEN` | 선택. Slack **봇** 토큰 (`chat:write` 권한). `QUOKY_SLACK_TOKEN`(읽기용)과 다른 토큰이어야 함 |
| `QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS` | 선택. 게시를 허용할 채널 `이름:채널ID` 또는 `채널ID` (쉼표, 최대 50개). 토큰과 채널이 둘 다 있어야 Slack 쓰기가 켜짐. 봇을 그 채널에 초대해야 함 |
| `QUOKY_OPS_UI_ENABLED`, `QUOKY_OPS_UI_PORT` | 선택. 기본 `false`, `47613`. 로컬 운영 화면 (7절 "운영 화면"). 잘못된 값은 시작 오류가 아니라 화면만 끔 |

`QUOKY_CHAT_PROVIDER`, `QUOKY_CODEX_MODEL`, `QUOKY_OLLAMA_ENABLED`, `QUOKY_CLAUDE_MODEL`, `QUOKY_GIT_REMOTE_ENABLED`, `QUOKY_CONTEXT_MAX_TOKENS`와 위의 Personal v2 변수들(`QUOKY_GIT_MERGE_ENABLED`, `QUOKY_WORK_SUMMARY_ENABLED`, `QUOKY_REMINDERS_*`, `QUOKY_TIMEZONE`, `QUOKY_EMBEDDING_*`), Personal v3의
`QUOKY_MEMORY_ARCHIVE_DAYS`, `QUOKY_LEARNING_EXAMPLES_ENABLED`, `QUOKY_CONNECTOR_WRITES_ENABLED`, `QUOKY_CALENDAR_WRITE_ENABLED`, `QUOKY_IMAGE_UNDERSTANDING_PROVIDER`는 빈 값(예:
`QUOKY_OLLAMA_ENABLED=`)을 "미설정"으로 보지 않고 시작 오류로 처리합니다. 쓰기 허용 목록과 Slack 쓰기 토큰도 형식이 틀리면
시작 오류입니다 (쓰기가 꺼져 있어도 검사). 반대로 `QUOKY_OPS_UI_*`와 (선택값을 설정하지 않았을 때의) `QUOKY_OLLAMA_VISION_MODEL`은 잘못되면 그 기능만 꺼집니다. 기본값을 쓰려면 줄을 지우거나 `#`으로
주석 처리하세요.

**주의 — 같은 이름의 셸 환경 변수가 `.env.local`보다 우선합니다.** 이미 셸에 `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID` 등이 있으면 `.env.local` 값은 무시됩니다. 시작 전에 **이름만** 확인하세요 (값은 출력하지
마세요).

```sh
env | grep DISCORD | cut -d= -f1      # 값 없이 이름만 표시
# 겹치는 이름이 있으면 이번 실행에서만 제거:
env -u DISCORD_BOT_TOKEN -u DISCORD_GUILD_ID pnpm dev
```

## 7. 실행

```sh
pnpm install
pnpm dev
```

`pnpm dev`는 빌드 후 봇을 시작합니다. 정상이면 로그에 아래와 비슷한 줄이 나옵니다.

- `database` — 실제로 열린 DB 파일의 절대 경로 (기본 `./data/chunsik.db`)
- `provider ready` — 준비된 provider 이름과 capability 목록
- `provider not ready` — 준비되지 않은 provider (예: Ollama 서버가 꺼져 있음). Claude가 준비되어 있으면 정상 동작
- `started (Quoky Personal v1)` — 시작 완료

준비된 provider 중 일상 대화를 처리할 수 있는 것이 하나도 없으면 아래 경고가 나오고, 봇은 "AI가 아직 설정되지
않았어요. 관리자가 Claude CLI 설치·로그인 또는 로컬 AI(Ollama) 설정을 확인해야 합니다."라고 답합니다 (로그의
"AI not configured"는 이 안내를 뜻합니다).

> no ready provider for GENERAL_CHAT: chat will reply "AI not configured" until the Claude CLI is installed and logged in, or Ollama is running with the configured model

시작 실패 시 `failed to start` 다음에 `how to fix`로 해결 방법이 출력됩니다 (9절 표).

### 상시 실행: macOS launchd 서비스 (선택, ADR-0102)

`pnpm dev`는 터미널을 닫으면 멈춥니다. 소유자의 Mac에서 Quoky를 로그인할 때 자동으로 띄우고, 비정상 종료 시
다시 띄우려면 launchd **사용자 에이전트**를 씁니다. macOS 전용이며 다른 OS에서는 스크립트가 거절합니다.
설치·업그레이드·제거·재시작은 소유자 컴퓨터의 로그인 세션을 바꾸는 **Strict 작업**이므로 소유자가 직접 승인하고
실행합니다. 항상 `--dry-run`으로 계획을 먼저 확인하세요 (`--dry-run`은 아무것도 바꾸지 않습니다).

**서비스가 하는 일**

- 환경은 셸에서 **아무것도 물려받지 않고** (`env -i`) 고정 `HOME`, `PATH`(node·claude·ollama 디렉터리 + 시스템
  디렉터리), `LANG`, `USER`와 호스트 `.env.local` 경로만으로 만듭니다. 셸에 `DISCORD_*`가 export되어 있어도 서비스에는
  들어가지 않습니다.
- `.env.local`은 **모드 600(본인 소유, group/other 권한 없음)** 이어야 합니다. 아니면 시작을 거절합니다. 스크립트는
  파일 내용을 읽거나 출력하지 않습니다.
- 서비스는 `QUOKY_RUNTIME_ENV=prod`로 실행되고 DB와 벡터 저장소는 저장소 밖
  `~/Library/Application Support/Quoky/`(`quoky.db`, `vectors`)를 씁니다. 이 값은 `.env.local`의 같은 이름보다 우선합니다.
  이 DB는 소유자의 실제 데이터입니다.
- 같은 DB를 쓰는 프로세스는 하나만 시작됩니다 (DB 옆 `quoky.db.lock/` 디렉터리). 두 번째 프로세스는
  `INSTANCE_ALREADY_RUNNING`으로 시작하지 않습니다. 이전 프로세스가 죽어서 남은 잠금은 그 pid가 없을 때만 자동으로
  넘겨받습니다(pid가 살아 있으면 재부팅으로 boot id가 바뀐 경우에만 — 시계 변경은 영향을 주지 않습니다).
  이전 빌드가 남긴 `quoky.db.lock` **파일**이 있으면 `INSTANCE_LOCK_UNAVAILABLE`로 멈추니, Quoky가 꺼진 상태에서 그
  파일을 지우세요.
- Discord 연결 직후, 알림을 보내기 전에 실제 연결된 봇 ID, 서버(`DISCORD_GUILD_ID`), 허용 채널
  (`QUOKY_DISCORD_CHANNEL_IDS`)이 `.env.local`과 같은지 확인합니다. 다르면 `DISCORD_IDENTITY_MISMATCH`로 멈춥니다.
- 설정 문제로 멈추면 종료 코드 78로 끝나고, **연속 3번**이면 launcher가 더 이상 다시 띄우지 않습니다. 고친 뒤
  `restart --apply`로 다시 시작합니다. 그 밖의 비정상 종료(충돌, `kill -9`)는 launchd가 10초 간격으로 다시 띄웁니다.
- 중지(`SIGTERM`)는 최대 90초를 기다립니다. 알림 전송 마무리 한도(65초)보다 깁니다.
- **Ollama 앱도 로그인할 때 시작되게** 두세요 (시스템 설정 -> 일반 -> 로그인 항목에 Ollama). Quoky가 Ollama보다
  먼저 뜨면 시작 로그에 Ollama provider가 `provider not ready`로 남지만, Ollama가 뜬 뒤 최대 약 2분 안에 재시작 없이
  준비됨으로 바뀝니다(`provider became ready`).
- 로그는 `~/Library/Logs/Quoky/quoky.log`입니다. 시작할 때 10 MiB를 넘으면 `quoky.log.1`로 돌리고 5개까지
  보관합니다. `launchd.log`는 launcher가 로그 파일을 열기 전 출력용 예비 로그입니다. 비밀 값은 로그에 쓰지 않습니다.

**준비**

```sh
pnpm install && pnpm build          # 서비스는 빌드된 apps/quoky/dist/main.js를 실행
chmod 600 .env.local                # 필수
```

`.env.local`에 봇 자신의 사용자 ID를 넣습니다 (Developer Portal -> General Information -> Application ID, 봇의 사용자
ID와 같음). 서비스로 실행할 때는 **필수**입니다.

```sh
QUOKY_DISCORD_EXPECTED_BOT_ID=<봇 사용자 ID>
```

권장 호스트 설정 (ADR-0102 D9): `QUOKY_REMINDERS_ENABLED=true` (기본값). 알림을 `#reminder` 같은 허용 채널로 받으려면
`QUOKY_REMINDERS_CHANNEL_DELIVERY=true` (그 채널의 모든 멤버가 알림 내용을 볼 수 있음). 일일 브리핑은 항상 DM입니다.

**설치, 상태, 재시작, 제거**

```sh
ops/launchd/quokyctl.sh install --dry-run     # 계획만 출력 (변경 없음)
ops/launchd/quokyctl.sh install --apply       # Strict: plist 작성 + launchctl bootstrap gui/<uid>
ops/launchd/quokyctl.sh status                # 읽기 전용: launchd 상태, 연속 설정 오류 횟수, 잠금, 로그 경로
ops/launchd/quokyctl.sh restart --apply       # Strict: 설정 오류 중지 해제 + launchctl kickstart -k
ops/launchd/quokyctl.sh uninstall --apply     # Strict: bootout + plist 삭제 (DB와 로그는 남김)
tail -f ~/Library/Logs/Quoky/quoky.log
```

`install`은 여러 번 실행해도 안전합니다. plist가 같고 이미 로드되어 있으면 아무것도 하지 않고, 바뀌었으면 내렸다가
다시 올립니다. `--node`, `--env-file`, `--repo`, `--label`로 기본값을 바꿀 수 있습니다. plist에는 비밀 값과 환경 변수가
없습니다 (템플릿: `ops/launchd/com.quoky.personal.plist`).

**주의**

- 서비스가 도는 동안 같은 봇 토큰으로 `pnpm dev`를 띄우지 마세요. DB가 달라 잠금에 걸리지 않으므로 두 프로세스가
  같은 메시지에 답할 수 있습니다. 먼저 `uninstall --apply` 또는 `launchctl bootout gui/$(id -u)/com.quoky.personal`로
  멈추세요.
- 기존 `./data/chunsik.db` 데이터를 서비스 DB로 옮기는 것과, 서비스 DB 스키마를 올리는 업그레이드(마이그레이션)는
  Strict 작업입니다. 서비스를 멈춘 상태에서 DB를 먼저 백업하세요. 정기 백업, 복구 절차, 운영 알림은 아래
  "백업과 운영 알림"을 보세요.
- Mac이 잠자기 상태면 알림이 늦게 전달됩니다. 전원 설정은 자동으로 바꾸지 않습니다. 필요하면 직접
  `시스템 설정 -> 배터리/에너지` 또는 `sudo pmset -c sleep 0`(전원 연결 시 잠자기 끔)을 설정하세요.

### 백업과 운영 알림 (ADR-0102 D6/D7)

**백업이 하는 일**

- 서비스(launchd)로 실행하면 기본으로 켜집니다. `pnpm dev`(개발 DB)에서는 기본으로 꺼져 있습니다.
- 매일 `QUOKY_TIMEZONE` 기준 04:00에 SQLite `VACUUM INTO`로 DB 사본을 만들고, 사본을 읽기 전용으로 검증합니다
  (`PRAGMA integrity_check`가 `ok`, `user_version`이 원본과 같음). 검증된 사본만 최종 이름을 받습니다. 한 번의
  복사+검증은 최대 5분이며 별도 스레드에서 돌아 Discord 응답과 알림을 멈추지 않습니다.
- Mac이 04:00에 잠자고 있었다면 깨어난 뒤 15분 안에 만듭니다. 시작할 때 최근 24시간 안의 일일 사본이 없으면
  시작 10분 뒤에 하나 만듭니다.
- 새 빌드가 기존 DB의 스키마를 올려야 하면(마이그레이션) `storage.init()` **전에** 사본을 하나 더 만들고
  검증합니다(`pre-migration`). 검증에 실패하면 마이그레이션 없이 시작을 거절합니다
  (`BACKUP_PRE_MIGRATION_FAILED`, 종료 코드 78: 3번 연속이면 launcher가 다시 띄우지 않습니다).
- 위치: `~/Library/Application Support/Quoky/backups/` (디렉터리 700, 파일 600).
  이름: `quoky-<UTC 시각>-daily.db`, `quoky-<UTC 시각>-pre-migration.db`.
- 보관: 최근 7일의 일일 사본 + 최근 4주의 주간 사본(그 주의 가장 최신 사본) + 최근 pre-migration 사본 3개.
  정리는 위 이름 형식의 일반 파일만 지웁니다. 같은 디렉터리의 다른 파일은 건드리지 않습니다.
- 상태: `backups/backup-status.json` (마지막 실행 시각과 결과, 검증 여부, 마지막 검증 사본, 보관 개수, 다음 예정
  시각; 파일 이름만 담고 경로나 내용은 담지 않습니다).

설정 (`.env.local`, 선택):

```sh
QUOKY_BACKUP_ENABLED=true            # 기본: 서비스에서 true, 그 밖에는 false. 정확히 true/false만 허용
QUOKY_BACKUP_DIR=/Volumes/Backup/quoky   # 기본: DB 디렉터리의 backups/. 절대 경로만 허용 (외장 디스크 권장)
```

**운영 알림 (`OPS_NOTICE`)**

소유자 **DM으로만** 고정 문구를 보냅니다(채널로는 절대 보내지 않음, 비밀 값이나 대화 내용 없음).

- 10분 안에 3번 이상 다시 시작된 뒤 정상적으로 시작했을 때 한 번 (같은 재시작 묶음에는 한 번만).
- 백업이 실패했거나 검증되지 않았을 때마다 한 번.
- 하루(24시간)에 최대 3개. 이 한도는 DB 옆 `ops/notice-ledger.json`(600)에 기록되어 재시작 후에도 유지됩니다.

알림을 받으면 `~/Library/Logs/Quoky/quoky.log`에서 `backup.failed`(실패 코드) 또는 재시작 원인을 확인하세요.

**복구 절차 (Strict, 소유자가 직접 승인·실행)**

복구는 자동으로 하지 않습니다. 실제 DB를 바꾸기 전에 반드시 임시 위치에서 연습(drill)합니다.

```sh
B="$HOME/Library/Application Support/Quoky/backups"
D="$HOME/Library/Application Support/Quoky"
ls -l "$B"; cat "$B/backup-status.json"                     # 1. 복구할 사본 고르기
cp "$B/<사본 이름>" /tmp/quoky-restore-drill.db               # 2. 연습: 임시 DB로 복사
sqlite3 /tmp/quoky-restore-drill.db 'PRAGMA integrity_check; PRAGMA user_version;'
#    -> "ok"와, backup-status.json의 userVersion과 같은 숫자가 나와야 합니다
launchctl bootout gui/$(id -u)/com.quoky.personal          # 3. 서비스 중지
mkdir -p "$D/before-restore"                                # 4. 현재 DB와 WAL 파일을 옆으로 옮김
mv "$D/quoky.db" "$D/quoky.db-wal" "$D/quoky.db-shm" "$D/before-restore/" 2>/dev/null
cp "$B/<사본 이름>" "$D/quoky.db" && chmod 600 "$D/quoky.db"    # 5. 사본을 DB 자리에 복사
ops/launchd/quokyctl.sh install --apply                     # 6. 서비스 다시 시작
rm /tmp/quoky-restore-drill.db
```

- 4단계에서 `quoky.db-wal`/`quoky.db-shm`을 반드시 함께 옮깁니다. 남겨 두면 옛 WAL이 복구한 DB에 적용될 수
  있습니다.
- 사본의 `user_version`이 지금 빌드보다 낮으면 다음 시작에서 마이그레이션이 일어납니다(Strict). 이때도 먼저
  pre-migration 사본이 자동으로 만들어집니다.
- 문제가 없으면 나중에 `before-restore/`를 직접 지우세요. 백업 정리 기능은 이 디렉터리를 건드리지 않습니다.

### 운영 화면 (선택, ADR-0113 OPS-1/OPS-2/OPS-2b)

Quoky 프로세스 안에서 도는 **로컬 전용** 웹 화면으로 서비스 상태를 봅니다. 기본으로 **꺼져 있고**, 켜도 이
Mac의 `127.0.0.1`에서만 열립니다(같은 네트워크의 다른 기기, 터널, 포트 포워딩으로는 열리지 않으며 그런 설정도
제공하지 않습니다). 상태를 보고(OPS-1), 알림 취소와 기억 잊기(OPS-2), 대기 중인 승인의 승인/거절(OPS-2b)을 할 수
있습니다. 대화는 채팅에서 하며, 채팅만으로도 모든 결정을 그대로 할 수 있습니다.

설정 (`.env.local`, 선택; 켜는 것은 소유자 호스트의 Strict 작업):

```sh
QUOKY_OPS_UI_ENABLED=true     # 기본 false. 정확히 true/false만 허용 (다른 값이면 화면만 꺼지고 로그에 OPS_UI_ENABLED_INVALID)
QUOKY_OPS_UI_PORT=47613       # 기본 47613. 1024-65535 (범위 밖이면 화면만 꺼지고 로그에 OPS_UI_PORT_INVALID)
```

이 두 값은 `config.ts`가 읽고 `.env.example`에 설명이 있습니다(W6 OPS-2b에서 합침). 다른 설정과 달리 잘못된 값은
시작 오류가 아니라 화면만 끕니다. 접속 주소(bind)를 바꾸는 설정은 없습니다.

**접속**

1. Quoky를 시작합니다. 시작할 때마다 새 접속 토큰(256비트)이 DB 디렉터리의 `ops-ui.token`(모드 600)에 쓰입니다.
   서비스에서는 `~/Library/Application Support/Quoky/ops-ui.token`, `pnpm dev`에서는 `./data/ops-ui.token`입니다.
   정상 종료하면 파일이 지워지고, 비정상 종료로 남은 파일은 다음 시작에서 교체됩니다.
2. 브라우저에서 `http://127.0.0.1:47613/`을 엽니다(`http://localhost:47613/`도 됨).
3. `cat "<DB 디렉터리>/ops-ui.token"`으로 토큰을 복사해 로그인 칸에 붙여 넣습니다. 토큰은 URL에 넣지 않으며 로그에도
   쓰지 않습니다. 로그인 실패가 1분에 5번이면 60초 동안 로그인을 막습니다.
4. 로그인은 그 프로세스가 도는 동안(최대 12시간)만 유효합니다. Quoky를 다시 시작하면 토큰이 바뀌니 다시 로그인합니다.

포트가 이미 쓰이고 있거나 토큰 파일을 만들 수 없으면 **화면만** 꺼지고 Quoky의 나머지는 그대로 시작합니다
(`quoky.log`의 `ops-ui.unavailable reason=PORT_IN_USE` 등).

**보이는 것** (15초마다 자동 갱신, 서버는 최소 10초 간격으로만 다시 계산)

| 패널 | 내용 |
|---|---|
| 런타임 / 상태 | 빌드 버전, 시작 시각, 가동 시간, DB `user_version`, 단일 인스턴스 잠금, 플랫폼 연결, 시작 신원 확인, 알림 틱 상태, 최근 10분 시작 횟수(launchd). 설치 manifest 해시, 재시작 횟수, 알림 틱 마지막 실행은 아직 `unknown` |
| AI 공급자 준비 상태 | **기능별** 준비됨 / 일부 불가 / 불가와 준비/등록 수(공급자 이름은 표시하지 않음), 설정값, 지금 적용되는 대화·이미지 모델 기본값과 출처, 대화별로 바꾼 대화 수, **모델 기본값 바꾸기** 링크 |
| 알림 대기열 | 예정·전달 중인 알림의 번호, 다음 시각, 반복, 상태, 대상(DM/채널), 지난 결과, 내용(`알림 목록`과 같은 60자) |
| 대기 중인 승인 | ID 앞 8자, 위험도, 작업 종류, 생성·만료(30분) 시각, 상태. 미리보기, diff, 대상, 설명은 표시하지 않음 |
| 커넥터 상태 | Jira/Slack/Confluence/GitHub 설정 여부, 읽기/쓰기, 마지막 확인 결과와 시각 |
| 최근 오류 | 이 프로세스가 시작된 뒤 최근 100건의 시각, 구성 요소, 분류, 코드, 상관 ID (메모리에만, 메시지 내용 없음) |
| 피드백 통계 | `피드백 요약`과 같은 30일 수치와 👎 비율 추이 |
| 백업 상태 | 정기 백업 사용, 마지막 실행과 결과, 마지막 검증 사본, 보관 사본(파일 이름), 다음 예정 |
| 기억 보관함 | 보관함에 있는 기억 수(내용은 표시하지 않음) |

비밀 값, 토큰, 대화 본문, 프롬프트, 승인 내용, 기억 내용은 표시하지 않습니다. 화면에 들어가는 모든 문자열은 자격
증명 검사를 한 번 더 거치고, 걸리면 `[hidden]`으로 바뀝니다.

**처리 (OPS-2, OPS-2b)**

모든 처리 버튼은 로그인 세션, 같은 출처(Origin), CSRF 토큰, 한 번만 쓰는 요청 값을 확인합니다. 같은 요청을 두 번
보내도 한 번만 처리합니다. 처리 기록(감사 로그)에는 내용이 남지 않습니다.

- **모델 기본값:** 대화 모델과 이미지 모델의 기본값을 바꿉니다(위 4절 "실행 중에 모델 바꾸기"). 다시 시작해도 유지되고
  소유자 DM으로 알립니다.
- **알림 취소:** 채팅의 `알림 N 취소`와 같은 처리입니다. 되돌릴 수 없습니다.
- **기억 잊기:** 채팅의 `기억 N 잊어줘`와 같은 처리입니다. 화면에 나온 확인 코드를 한 번 더 입력해야 실행되고(5번까지),
  잊은 기억은 채팅과 같이 보관함으로 갑니다.
- **거절:** 대기 중인 승인을 거절합니다. 채팅에서 `거절`한 것과 같습니다.
- **승인:** 운영 화면이 켜져 있는 동안 채팅의 승인 미리보기 끝에 `운영 화면 확인 코드: XXXXXX`(6자리) 줄이 붙습니다.
  화면에서 승인하려면 이 코드를 입력합니다(가장 최근 미리보기의 코드, 30분 안, 한 번만). 5번 틀리면 그 승인은 30분 동안
  화면에서 승인할 수 없고 채팅에서는 그대로 결정할 수 있습니다. 화면에는 미리보기, diff, 대상, 본문을 표시하지 않으니
  내용은 채팅 미리보기에서 확인하세요.
  - 화면의 승인은 **승인만 기록**합니다. 실제 실행(커밋, 푸시, PR, 머지, Jira/Slack/캘린더 쓰기 등)은 지금처럼 채팅의
    실행 문구(`커밋 실행`, `댓글 실행` 등)로만 합니다.
  - 승인하는 순간 작업이 이어서 실행되는 종류(코드 변경 계획 승인, `그래도 보내줘` 예외)는 채팅에서만 승인할 수 있고,
    화면에서는 거절만 됩니다.
  - 화면에서 승인/거절하면 결과가 소유자 DM으로 한 번 갑니다(`OPS_DECISION_RESULT`). 화면에는 결과 종류와 DM 전달
    여부만 나옵니다. 채팅과 화면에서 동시에 결정해도 하나만 적용됩니다.
- 소유자 ID가 정확히 하나의 사용자(Actor)에 연결되어 있지 않으면 처리 버튼은 동작하지 않습니다. 채팅을 쓰세요.

> 실제 Mac에서 확인한 것은 로그인까지입니다(Chromium에서 출처 검사로 로그인이 거부되던 문제는 PR #131에서 고침).
> 화면에서의 알림 취소, 기억 잊기, 승인/거절은 오프라인 테스트만 통과했고 실제 환경 검증은 아직입니다.

## 8. 처음 사용하기

봇에게 DM을 보내거나 `QUOKY_DISCORD_CHANNEL_IDS`에 넣은 채널에 메시지를 보냅니다 (@멘션 불필요).

```text
안녕
도움말
```

### 대화 제어

정확히 이 문구만 한 메시지로 보낼 때 동작합니다 (공백 앞뒤는 무시, 영문은 대소문자 무시). Discord 슬래시 명령이
아니라 일반 텍스트 메시지입니다. 문장 속에 포함된 경우("새 대화 기능 만들어줘")는 일반 요청으로 처리됩니다.

| 보낼 말 | 동작 |
|---|---|
| `도움말` (권장) 또는 `/help` | 할 수 있는 일과 사용 문구를 보여 줌. AI 호출 없음 |
| `새 대화` (권장) 또는 `/reset` | 지금 대화(세션)를 끝내고 새로 시작. 기다리던 승인 요청은 거절로 처리. 이미 적용한 파일 변경/커밋은 되돌리지 않고, `기억해:`로 저장한 내용은 유지 |

> **Discord 팁:** 메시지 입력창에 `/help`나 `/reset`처럼 `/`로 시작하는 글을 쓰면 Discord의 슬래시 명령 선택 창이
> 열리고, 그 상태에서 Enter를 누르면 메시지가 전송되지 않을 수 있습니다. `도움말`/`새 대화`를 쓰거나, `/help`·`/reset`을
> 쓸 때는 **Esc로 선택 창을 닫은 뒤 Enter**를 누르세요.

> **주의:** `새 대화`는 세션을 닫으므로 **활성 프로젝트 연결도 함께 사라집니다.** 새 대화에서 코드 작업을 이어가려면
> 프로젝트를 다시 등록(활성화)하세요.

### 기억

```text
기억해: 내 배포 창은 화요일이야
```

`기억해: <내용>` (또는 `기억해줘: <내용>`, `remember: <내용>`)으로 보낸 내용은 오래 보관되며, **채널/DM/새 대화와
상관없이 같은 소유자의 이후 대화에서 회상**됩니다. 평범한 대화는 장기 기억으로 저장되지 않습니다.

저장된 기억은 `기억 목록`, `기억 N 보여줘`, `기억 N 수정: <내용>`, `기억 N 잊어줘`로 관리합니다. 수정과 잊기는 답장에
나온 확인 코드를 `기억 확인 <코드>`로 보내야 실행됩니다.

- **잊기 = 더 이상 쓰지 않음.** 확인한 기억(과 고쳐 쓰기 전 버전)은 **보관함**으로 옮겨져 목록, 회상, 대화 문맥,
  학습 어디에도 쓰이지 않습니다. 기본 7일(`QUOKY_MEMORY_ARCHIVE_DAYS`) 뒤 매일 정리 작업이 완전히 지웁니다.
- **이번 대화 기록도 비웁니다.** 잊기/수정을 확인하면 그 내용이 담긴 내 대화 기록(다른 대화 포함)을 지우고, 지금
  대화의 내 기록도 비웁니다(답장에 "이번 대화 기록도 비웠어요"). 프로젝트 연결과 다른 기억은 그대로이고, 지운 대화
  기록은 보관하지 않습니다.
- `보관함`: 보관된 기억과 남은 일수를 봅니다. **보관함 번호는 `기억 목록` 번호와 따로 매겨집니다.**
- `기억 복원 N`: 보관함 N번을 되돌립니다(다시 목록·회상에 쓰임). `기억 완전 삭제 N`: 보관함 N번을 바로 완전히 지웁니다.
  둘 다 확인 코드(`기억 확인 <코드>`)가 필요합니다.
- 비밀번호·토큰처럼 보이는 내용은 보관하지 않고 바로 완전히 지웁니다. `QUOKY_MEMORY_ARCHIVE_DAYS=0`이면 모든 잊기가
  바로 완전 삭제입니다.
- 영어: `list memories`, `forget memory N`, `memory archive`, `restore memory N`, `permanently delete memory N`.

### 승인

위험한 작업은 먼저 승인을 요청합니다.

- 진행하려면 `승인`, 거절하려면 `거절`이라고 답합니다.
- **30분** 안에 답하지 않으면 자동으로 거절됩니다.
- 승인을 기다리는 동안 보낸 다른 메시지는 대화로 가지 않고 "승인을 기다리는 작업이 있어요" 알림(위험도, 남은 시간
  포함)을 받습니다. 그만두려면 `새 대화`를 보내세요.
- 기다리는 승인 요청이 없을 때 `승인`/`거절`/`취소`만 보내면 AI에게 넘기지 않고 "지금 승인하거나 거절할 작업이
  없어요…"라고 답합니다 (이전 요청은 이미 처리됐거나 만료됐을 수 있음).
- `진행하지 마`처럼 부정된 문구는 승인으로 해석되지 않습니다 (거절로 처리됩니다). 질문, 조건이 붙은 말,
  "먼저 보고…" 같은 보류 표현은 결정으로 보지 않고 다시 묻습니다.

### 로컬 코드 수정 흐름

작업 대상은 컴퓨터에 있는 Git 저장소여야 하고, `pnpm test`가 동작하는 프로젝트를 권장합니다. 처음에는 **버려도
되는 샘플 저장소**로 연습하세요. 한 단계씩 말한 문구 그대로 보내면 됩니다.

| 단계 | 보낼 말 (예) | 결과 |
|---|---|---|
| 1. 프로젝트 등록 | `이 프로젝트 등록해줘: /절대/경로/my-repo` | 절대 경로(2단계 이상)와 `등록`이 있어야 인식. `../repo`, `~/repo` 같은 상대 경로는 "프로젝트는 절대경로로 등록해 주세요…" 안내만 받고 등록되지 않음 |
| 2. 변경 요청 | `src/target.ts 파일을 수정해줘: ...` 또는 `/preview src/target.ts ...` | 코드 변경 승인 요청 (파일 경로를 함께 적어야 함, 아래 참고) |
| 3. 계획 승인 | `승인` | 파일을 바꾸지 않는 **변경 미리보기(diff)** 가 전송됨 |
| 4. 적용 의사 | `적용해줘` | 적용 전 두 번째 승인 요청. 아직 파일은 그대로 |
| 5. 적용 승인 | `승인` | 패치를 만들 준비 상태 |
| 6. 패치 생성 | `패치 만들어줘` | 패치 미리보기. 아직 파일은 그대로 |
| 7. 파일 적용 | `패치 적용해줘` | 실제 파일 수정 (`파일을 수정했어요: ...`). git 명령, 커밋, 테스트는 실행하지 않음 |
| 8. 검증 | `테스트 실행해줘` 또는 `타입체크 실행해줘` | 등록한 저장소에서 `pnpm test` / `pnpm typecheck` 실행 |
| 9. (선택) 로컬 커밋 | `커밋해줘` -> `승인` -> `커밋 실행` | 로컬 커밋만. `main`/`master` 브랜치면 `커밋해줘` 단계에서 바로 거절(승인 요청 없음) |

> **파일 경로 규칙:** 대상 파일 경로는 프로젝트 기준 상대 경로이며 디렉터리를 최소 하나 포함해야 합니다(예: `src/app.ts`). 저장소 루트의 파일(`README.md`, `index.js`)은 Personal v1에서 대상으로 인식되지 않으며, 이 경우 "수정할 파일 경로와 함께 다시 요청해 주세요."라는 안내가 한 번 돌아옵니다. 경로를 포함해 다시 요청하면 됩니다.
> 경로를 적었지만 프로젝트에 없는 파일이거나 프로젝트 밖 경로(`/etc/hosts`, `../../x`, `~/.ssh/config` 등)이면 "요청한 파일을 프로젝트 안에서 찾을 수 없거나 프로젝트 밖 경로예요: …"라는 안내가 돌아옵니다 (프로젝트 밖 파일의 존재 여부는 확인하지도, 알려 주지도 않습니다).

> **여러 파일:** 한 요청에 파일을 최대 5개까지 적을 수 있습니다. 없는 파일은 "만들어줘"처럼 새로 만든다는 말이 있을 때만 새 파일로 다룹니다. 적용은 실패하면 되돌립니다.

> **그래도 보내줘 (비밀번호처럼 보이는 파일 한 번 보내기):** 대상 파일에 `token = ...` 같은 비밀 값 할당이 있어 보이면 미리보기가 거절되는 대신, Quoky가 파일과 줄 번호를 알려 주며 **한 번만** 외부(AI)로 보낼지 묻습니다. 보내려면 정확히 `그래도 보내줘`(또는 `그래도 보내`, `그래도 전송해줘`, `send anyway`)라고 답하세요. `승인`/`좋아`는 허용이 아니며 다시 안내합니다. 취소는 `취소`나 `보내지 마`. 한계:
> - 한 번만 유효하고, 보낸 뒤 같은 허용으로 다시 보내지 않습니다 (실패해도 새 요청과 새 확인이 필요).
> - 30분 안에 답하지 않거나, `새 대화`, 거절, 파일 내용 변경, 더 새로운 요청이 있으면 무효가 됩니다. 여러 파일이면 파일마다 따로 확인합니다.
> - **허용되지 않는 경우:** 비밀 파일 이름(`.env`, 키 파일 등)과 토큰/키 모양의 내용(`ghp_...` 등)은 이 방법으로도 보낼 수 없습니다. "확인을 받아도 보낼 수 없어요"라고 답합니다.
> - 아무것도 대기 중이 아닐 때 `그래도 보내줘`만 보내면 아무 파일도 보내지 않았다고 답합니다.
> - 이 확인도 패턴 기반 best-effort입니다. 비밀 값이 든 파일은 가능하면 대상으로 지정하지 마세요.

> **AI에게 전달되는 내용 (best-effort 안내):** 코드 변경을 승인하면 지정한 파일의 현재 내용이 미리보기 생성을 위해 AI에게 전달됩니다. 승인 요청 메시지에도 같은 안내가 표시됩니다. 비밀번호·키가 들어 있는 파일은 보내지 않도록 확인하지만, 이 확인은 패턴 기반의 **best-effort**라서 모든 경우를 걸러내지는 못합니다. 비밀 값이 든 파일은 대상으로 지정하지 마세요.

> **경고 — 8단계의 `테스트 실행해줘`는 별도 승인 없이 등록한 저장소 체크아웃에서 `pnpm test`를 실행합니다.**
> 신뢰하지 않는 프로젝트나 테스트 스크립트가 위험한 저장소는 등록하지 마세요. 부정문("테스트 실행하지 마")은 실행으로
> 해석되지 않습니다.

### Personal v2 기능 (문구 모음)

아래 문구는 모두 소스의 문법/핸들러에서 확인한 것입니다. 일부는 켜야 동작합니다(표의 "필요").

| 기능 | 보낼 말 (예) | 필요 | 결과 |
|---|---|---|---|
| 알림 만들기 | `1분 뒤에 스트레칭 알려줘`, `내일 오전 9시에 회의 준비 알려줘`, `매일 오전 8시에 오늘 할 일 알려줘` | `QUOKY_REMINDERS_ENABLED` 켜짐 (기본) | "오후 10:08에 '스트레칭' 알려드릴게요 (#1 · 취소: '알림 1 취소')". 기본으로 소유자 DM으로 전달. 최소 1분 뒤부터, 본문 200자, 활성 알림 50개까지 |
| 알림 목록/취소 | `알림 목록`, `알림 1 취소` | 위와 같음 | 예정된 알림 보기, 하나씩 취소 |
| 정보 질문은 알림 아님 | `내일 9시에 뭐 있어? 알려줘` | - | 알림이 만들어지지 않고 대화로 감 (일정은 볼 수 없다고 답함) |
| 할 일 추가 | `할 일 추가: 보고서 초안 쓰기` | - | 로컬 할 일 목록에 추가. 내용에 시간 표현이 있어도 할 일이며(`할 일 추가: 내일 9시에 회의 알려줘`), 알림은 설정하지 않았다고 알려 줌 |
| 할 일 보기 | `내 할 일 보여줘`, `할 일 목록` | - | 번호가 붙은 목록. Jira/GitHub 식별자가 설정돼 있으면 그 항목도 함께 (아니면 계정 정보(identity)가 설정되어 있지 않다는 안내) |
| 할 일 완료/취소 | `완료 처리: 2`, `할 일 취소: 1` | - | 번호로 처리. 없는 번호는 아무것도 바꾸지 않음. 자연 문장(`보고서 쓰기 완료`)은 바꾸지 않고 `완료 처리: N` 사용을 안내 |
| 할 일 연결 | `할 일 연결: 1 Jira ABC-1` | - | 링크만 기록하고 외부 시스템은 조회/변경하지 않음 |
| 업무 조회 (읽기 전용) | `내 Jira 이슈 보여줘`, `GitHub 리뷰 요청 보여줘`, `Slack에서 배포 검색` | 커넥터 자격 증명 (운영자 가이드) | 읽기 전용 조회. 항목이 있으면 모델 요약이 붙을 수 있음 (`QUOKY_WORK_SUMMARY_ENABLED=false`면 목록만). 이슈 생성 등은 하지 않음. Jira 댓글/상태 변경과 Slack 게시는 v3의 승인 흐름으로만 (아래 "Personal v3 기능") |
| 피드백 | 봇 답장에 👍/👎 반응 (소유자만), 반응 제거 = 철회 | - | 로컬에 기록 (메시지 내용은 저장하지 않음) |
| 피드백 요약 | `피드백 요약` (정확히 이 문구) | - | 최근 30일 집계 (일반 대화, 위험 민감 대화 등 한국어 라벨). 읽기 전용 |
| 그래도 보내줘 | `그래도 보내줘` | 비밀 값처럼 보이는 파일이 대상일 때 | 위 "그래도 보내줘" 설명 참고. 한 번만 유효 |
| 브랜치 | `브랜치 만들어줘 feature/x`, `feature/x 브랜치로 전환해줘` | 등록된 프로젝트 | 로컬 브랜치만 만들거나 전환 (`main`/`master`는 대상 아님, 삭제/푸시/강제 등은 처리 안 함) |

정책에 민감한 질문(메일 발송 같은 외부 작업, 내 수신함 같은 본인 데이터, 한국어/영어 외 언어)은 Claude가 처리하며,
Quoky는 그런 외부 작업을 할 수 없다고 정직하게 답합니다. 캘린더가 설정되어 있으면 일정 질문은 캘린더에서 바로 답하고
(아래), 설정되어 있지 않으면 내 일정은 볼 수 없다고 답합니다.

### Personal v3 기능 (문구 모음)

아래 문구도 소스의 문법/핸들러와 도움말 줄에서 확인한 것입니다. `도움말`은 켜진 기능의 줄만 보여 줍니다.

| 기능 | 보낼 말 (예) | 필요 | 결과 |
|---|---|---|---|
| 사용법 질문 | `완료 처리 어떻게 해?`, `알림 어떻게 지워?` | - | 그 기능의 도움말 줄만 보여 줌. AI 호출 없음 |
| 모델 바꾸기 | `모델 상태`, `모델 목록`, `모델 변경: codex`, `/model claude:opus`, `이미지 모델 변경: off`, `모델 기본값으로` | 소유자 | 이 대화에서만 대화/이미지 모델을 바꿈 (4절 "실행 중에 모델 바꾸기"). AI 호출 없음 |
| 기억 관리 | `기억 목록`, `기억 2 보여줘`, `기억 2 수정: …`, `기억 2 잊어줘`, `보관함`, `기억 복원 1`, `기억 완전 삭제 1` | - | 위 "기억" 절. 수정/잊기/복원/완전 삭제는 `기억 확인 <코드>`로 한 번 더 확인 |
| 기억에 없는 질문 | `내가 좋아하는 과일이 뭐였지?` (저장된 기억 없음) | - | "그 내용은 기억에 없어요. 알려 주시면 "기억해: …"로 저장해 둘게요." (지어내지 않음) |
| 했다고 착각하는 답 막기 | (예: 모델이 "커밋했어요", "할 일에 넣었어요"라고 답하려 할 때) | - | 실제로 하지 않은 Quoky 작업을 했다고 말하는 답은 "하지 않았다"는 안내와 쓸 명령으로 바뀜. 문장 패턴 기반 best-effort |
| 학습 후보 | `피드백 후보`, `후보 1 메모: 더 짧게`, `후보 1 예시로 저장`, `예시 목록`, `예시 1 수정: …`, `예시 1 삭제` | - | 👎/👍 받은 답을 하나씩 골라 이 컴퓨터에만 저장(365일, 비밀값처럼 보이면 거절). 예시를 실제 프롬프트에 쓰려면 `QUOKY_LEARNING_EXAMPLES_ENABLED=true` (로컬 모델에만) |
| 캘린더 보기 | `오늘 일정`, `내일 일정 뭐야?`, `이번 주 일정`, `다음 회의 언제야?`, `내일 바빠?` | 캘린더 설정 (아래) | `QUOKY_TIMEZONE` 기준 일정 목록. AI 호출 없음. 일정 내용은 Claude로 보내지 않음 |
| 일정 추가/변경/삭제 | `내일 오후 3시에 회의 잡아줘 제목 주간 회의` → `승인` → `일정 추가 실행`; `일정 오후 6시로 옮겨줘` → `승인` → `일정 변경 실행`; `내일 3시 회의 취소해줘` → `승인` → `일정 삭제 실행` | `QUOKY_CALENDAR_WRITE_ENABLED=true` + `calendar.events` 토큰 | 기본 캘린더만. 정확한 내용 미리보기 후 한 번만 실행. 참석자 없음, 초대/변경 메일 없음. 대상이 여러 개면 번호 목록으로 묻고 추측하지 않음. 쓰기가 꺼져 있으면 "읽기만 할 수 있어요 … 아무것도 바꾸지 않았어요" |
| Jira 댓글 | `ABC-1에 댓글: 확인했습니다` → `승인` → `댓글 실행` | `QUOKY_CONNECTOR_WRITES_ENABLED=true` + 프로젝트 허용 목록 | 정확한 내용 미리보기, 한 번만 쓰는 승인(CRITICAL). 허용 목록 밖이면 아무것도 보내지 않음 |
| Jira 상태 변경 | `ABC-1 진행 중으로 바꿔줘` → `승인` → `상태 변경 실행` | 위와 같음 | 미리보기에 나온 전환(transition)과 대상 상태만 실행. 그 사이 이슈가 바뀌면 실행하지 않음 |
| Slack 게시 | `#dev-test에 게시: 배포 끝났어요` 또는 `#dev-test에 배포 끝났어요라고 올려줘` → `승인` → `Slack 게시 실행` | 쓰기 스위치 + Slack 봇 토큰 + 채널 허용 목록 | 허용된 채널에만. 봇을 채널에 초대하지 않았으면 "대상을 찾지 못했어요. 아무것도 보내지 않았어요." |
| 첨부 파일 | 메시지에 텍스트 파일(`.txt`·`.log`·`.md`·`.json` 등, 256KiB까지) 첨부 | - | 내용을 대화 문맥으로 씀(신뢰하지 않는 입력, 비밀값처럼 보이면 거절). 한 메시지에 3개까지. 긴 파일은 앞뒤 일부만(모두 합쳐 약 2,000자, 이미지와 함께 보내도 같음). 파일 이름이 비밀값처럼 보이면 `attachment-1.log`처럼 바꿔 씀. 읽을 수 있는 첨부가 하나도 없을 때 메시지 글이 비어 있으면(멘션이나 보이지 않는 문자만 있어도 빈 것으로 봄) 모델에 묻지 않고 안내만 함. 글이 있으면 "첨부를 읽지 못함(내용 추측 금지)"을 알린 채 평소처럼 답함. 작업 폴더에 저장하지 않음 |
| 이미지 | PNG·JPEG·WebP 첨부 (8MiB까지, 한 메시지에 3개까지) | `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` (`ollama`/`claude`/`off`, 5절) | 고른 provider 하나만 분석. 기본(미설정)은 로컬 비전 모델만(`QUOKY_OLLAMA_VISION_MODEL`). `claude`를 고르면 이미지가 Anthropic으로 전송됨(소유자가 명시적으로 고를 때만). 준비된 provider가 없으면 "분석하지 않았어요 … 어디로도 보내지 않았어요". 이미지 속 비밀값은 미리 찾을 수 없고, 답에 비밀값처럼 보이는 내용이 있으면 보여 주지도 저장하지도 않음. 분석하는 동안만 비공개 임시 파일에 두고, 처리가 끝나면 지움(남은 임시 파일은 시작할 때와 주기적으로 정리) |

쓰기 실행 규칙 (Jira/Slack/캘린더 공통):

- 실행 문구(`댓글 실행`, `상태 변경 실행`, `Slack 게시 실행`, `일정 추가/변경/삭제 실행`)는 `승인` 뒤에 **안내된 문구 그대로**
  보낼 때만 실행됩니다. "댓글 실행해도 돼?" 같은 질문에는 실행하지 않고 보낼 문구를 다시 안내합니다.
- 승인한 내용과 정확히 같은 것만 한 번 보냅니다. 보냈는지 확실하지 않으면(`UNCERTAIN`) 다시 시도하지 않고 보냈을 수도
  있다고 알립니다. 이미 보낸 뒤 같은 실행 문구를 다시 보내면 다시 보내지 않고 이미 실행했다고 링크와 함께 답합니다.
- 승인하고 실행하지 않은 쓰기는 승인 만료 시간(30분)이 지나면 무효가 됩니다.

**캘린더 설정 (Strict, 소유자가 직접):** Google Cloud 프로젝트에서 Calendar API를 켜고 OAuth "Desktop app" 클라이언트를
만든 뒤 `QUOKY_CALENDAR_GOOGLE_CLIENT_ID`/`QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET`를 `.env.local`에 넣습니다. 그리고 한 번
동의 도구를 실행합니다. 토큰은 화면에 출력하지 않고 새 파일(모드 600)에만 씁니다.

```sh
pnpm build
node apps/quoky/dist/tools/calendar-auth.js --out ./data/google-calendar-token.json                 # 읽기만
node apps/quoky/dist/tools/calendar-auth.js --out ./data/google-calendar-token-rw.json --with-events  # 일정 쓰기도
```

`.env.local`의 `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE`에 만든 파일 경로를 넣고 재시작합니다. `calendar.readonly`와
`calendar.events`보다 넓은 권한은 거부합니다. 서비스로 실행할 때는 토큰 파일을 서비스 데이터 디렉터리에 두는 것을
권장합니다.

### push와 PR (선택, `QUOKY_GIT_REMOTE_ENABLED=true` 필요)

기본값(`false`)에서는 push 요청이 "원격 git 작업(push 등)은 …꺼져 있어요(QUOKY_GIT_REMOTE_ENABLED=false)"로 거절되고
git 프로세스나 자격 증명을 쓰지 않습니다. 켜려면 운영자 가이드의 GitHub App 설정이 먼저 필요합니다. 흐름은 한 단계씩
말한 문구 그대로 보냅니다 (위 로컬 코드 수정 흐름의 9단계 `커밋 실행`까지 끝난 뒤, 기능 브랜치에서).

| 단계 | 보낼 말 | 결과 |
|---|---|---|
| 1. push 요청 | `푸시해줘` | CRITICAL 승인 요청. 처음 올리는 브랜치면 새 원격 브랜치로 올린다는 안내 |
| 2. 승인 | `승인` | 권한만 기록. 아직 push하지 않음 |
| 3. push 실행 | `푸시 실행` | 새 브랜치로만 push (force 없음, upstream 설정 없음) |
| 4. PR 요청 | `PR 만들어줘` | CRITICAL 승인 요청 (대상은 `main`) |
| 5. 승인 | `승인` | 권한만 기록 |
| 6. PR 생성 | `PR 생성 실행` | PR 생성. "아직 머지/배포/릴리즈는 하지 않았어요" |
| (선택) 상태 | `PR 상태 알려줘` | PR/리뷰/체크 상태. GitHub App에 Checks 권한이 없으면 "현재 PR 상태를 확인하지 못했어요"라고 솔직히 답함 |

- 이미 push했거나 PR을 만든 뒤 `푸시 실행`/`PR 생성 실행`을 다시 보내면 새로 만들지 않고 "이미 …했어요"라고 답합니다.
  `강제 푸시해줘`는 지원하지 않고, `배포해줘`는 "머지/배포/릴리즈는 이후 단계예요"로 거절됩니다.
- `main`/`master`로의 push(기능 브랜치가 `origin/main`을 추적하는 경우 포함)와 `main`/`master`에서의 커밋은 항상 거절됩니다.
- 머지: `QUOKY_GIT_MERGE_ENABLED=false`(기본)이면 `PR 머지해줘`가 "병합은 이 설정에서 꺼져 있어요…"로 거절되고 승인도 만들지 않습니다.
  PR은 GitHub에서 직접 검토하고 병합하세요.
- PR 제목은 승인한 커밋의 제목(커밋 메시지 첫 줄)이고, 본문은 커밋, 브랜치, 바뀐 파일 목록입니다 (v3). 승인 미리보기에
  나온 제목/본문 그대로만 PR을 만듭니다. 모델이 제안하는 제목/본문은 아직 없습니다.
- 승인 절차는 우회되지 않습니다. 각 단계의 외부 영향은 해당 실행 문구를 보낼 때만 일어납니다.
- 승인 후 실제 실행 단계(`커밋 실행`, `패치 적용해줘`, `푸시 실행`, `PR 생성 실행`, 머지, `main 동기화해줘`, `브랜치 정리해줘`, 원격 브랜치 삭제 실행)는 **안내된 문구 그대로**(띄어쓰기·마침표·존댓말 차이 정도만 허용) 보낼 때만 실행됩니다. 질문("푸시 실행해도 돼?"), 부정("…할 필요 없어"), 다른 표현에는 아무것도 바꾸지 않고 보낼 문구를 다시 안내합니다.

## 9. 문제 해결

시작 단계 힌트는 소스(`bootstrap-preflight.ts`)의 문구와 같습니다.

| 증상 / 로그 | 의미와 해결 |
|---|---|
| `DISCORD_BOT_TOKEN_MISSING` — "Set DISCORD_BOT_TOKEN in the process environment or .env.local (Discord Developer Portal -> Bot -> Reset Token), then restart." | 토큰이 없거나 비어 있음. `.env.local`에 채우고 재시작 |
| `DISCORD_TOKEN_INVALID` — "DISCORD_BOT_TOKEN was rejected by Discord. Reset the bot token in the Developer Portal and update it." | 토큰이 틀리거나 재발급됨. 같은 이름의 셸 환경 변수가 덮어쓰고 있지 않은지도 확인 |
| `DISCORD_DISALLOWED_INTENTS` — "Enable the "Message Content Intent" under Discord Developer Portal -> Bot -> Privileged Gateway Intents, then restart." | 2절 3번을 안 함 |
| `DISCORD_OWNER_IDS_MISSING` — "Set QUOKY_DISCORD_OWNER_IDS to your Discord user id (comma-separated for several; Discord -> Settings -> Advanced -> Developer Mode, then right-click your name -> Copy User ID), then restart." | 소유자 ID 없음 (시작 시 fail-closed) |
| `DISCORD_OWNER_IDS_INVALID` — "QUOKY_DISCORD_OWNER_IDS must be comma-separated Discord user ids (17-20 digits each, no empty entries)." | 형식 오류 (빈 항목, 자릿수) |
| `DISCORD_CHANNEL_IDS_INVALID` — "QUOKY_DISCORD_CHANNEL_IDS must be unset/empty (direct messages only) or comma-separated Discord channel ids (17-20 digits each, no empty entries)." | 채널 ID 형식 오류 |
| `OLLAMA_ENABLED_INVALID` — "QUOKY_OLLAMA_ENABLED must be unset, "true", or "false"." | `True`, `1`, `yes` 등은 불가 |
| `CLAUDE_MODEL_INVALID` — "QUOKY_CLAUDE_MODEL must be unset or a Claude model alias/name such as "sonnet" (letters, digits, and . _ : / [ ] -; up to 128 characters)." | 모델 이름 형식 오류 |
| `CHAT_PROVIDER_INVALID` — "QUOKY_CHAT_PROVIDER must be unset, "claude", "codex", or "ollama" (exactly, lowercase)." | 대문자, 공백, 빈 값, 다른 이름은 불가 |
| `CODEX_MODEL_INVALID` — "QUOKY_CODEX_MODEL must be unset (the Codex CLI default model) or a model name (letters, digits, and . _ : / [ ] -; up to 128 characters)." | Codex 모델 이름 형식 오류 |
| 시작 로그에 `CHAT_PROVIDER_OVERRIDES_OLLAMA_ENABLED` | `QUOKY_CHAT_PROVIDER`와 `QUOKY_OLLAMA_ENABLED`가 서로 다름. `QUOKY_CHAT_PROVIDER` 값으로 동작 중. 경고를 없애려면 `QUOKY_OLLAMA_ENABLED` 줄을 지우기 |
| `QUOKY_CHAT_PROVIDER=codex`인데 대화를 Claude가 답함 | Codex가 준비되지 않음. `codex login status`가 "Logged in"인지, launchd 서비스라면 `CODEX_CLI_BIN`(절대 경로)과 `node`가 PATH에 있는지 확인 |
| `GIT_REMOTE_ENABLED_INVALID` — "QUOKY_GIT_REMOTE_ENABLED must be unset, "true", or "false"." | `true`/`false`만 허용 |
| `CONTEXT_MAX_TOKENS_INVALID` — "QUOKY_CONTEXT_MAX_TOKENS must be unset or a positive integer (at most 200000)." | 양의 정수, 최대 200000 |
| 로그에 `no ready provider for GENERAL_CHAT ...` / 봇이 "AI가 아직 설정되지 않았어요…"로 답함 | Claude CLI 미설치(`claude --version` 실패)이고 Ollama도 준비 안 됨. `claude --version`, Ollama 서버/모델(`ollama list`) 확인 |
| 봇이 "AI 인증이 필요해요. 관리자가 Claude CLI 로그인을 확인해야 합니다."로 답함 | Claude CLI는 설치됐지만 로그인되지 않음. 준비 확인은 `claude --version`만 보므로 로그에 `provider ready claude-cli`가 나와도 이 상태일 수 있음. `claude`를 실행해 로그인 후 재시도 |
| 로그에 `provider not ready` (ollama) | Ollama 서버가 꺼져 있거나 `OLLAMA_MODEL`이 없음. Claude가 준비되어 있으면 자동으로 Claude로 답함 |
| 봇이 아무 답도 안 함 | 보낸 사람이 `QUOKY_DISCORD_OWNER_IDS`에 없거나, 채널이 `QUOKY_DISCORD_CHANNEL_IDS`에 없음 (소유자가 아니면 의도적으로 무응답). 서버를 제한하는 `DISCORD_GUILD_ID`도 확인. MESSAGE CONTENT INTENT 확인 |
| `.env.local`을 고쳤는데 반영이 안 됨 | 같은 이름의 셸 환경 변수가 우선함. `env | grep DISCORD | cut -d= -f1`로 이름 확인 후 `env -u NAME`으로 제거해 실행. 수정 후에는 재시작 필요 |
| "먼저 사용할 프로젝트를 등록해 주세요." | 활성 프로젝트가 없음. `새 대화` 뒤에도 마찬가지. 프로젝트를 다시 등록 |
| 승인 알림만 계속 옴 | 승인 대기 중임. `승인`/`거절`로 답하거나 `새 대화`로 그만둠. 30분 뒤 자동 거절 |
| `/help`·`/reset`을 보냈는데 아무 반응이 없음 | Discord 슬래시 명령 선택 창이 열려 메시지가 전송되지 않았을 수 있음. `도움말`/`새 대화`를 보내거나, Esc로 선택 창을 닫은 뒤 Enter |
| Ollama로 대화하는데 앞의 대화/기억을 자주 잊음 | Ollama 서버가 기본 4096 토큰 창으로 모델을 실행하는데 Quoky 기본 예산은 약 6000 토큰. `ollama serve`를 실행하는 환경에 `OLLAMA_CONTEXT_LENGTH=8192`를 설정해 서버를 다시 시작하거나, `.env.local`의 `QUOKY_CONTEXT_MAX_TOKENS`를 4096보다 충분히 낮게 설정 (5절) |
| `ollama list`에 모델이 있는데 로그에 `provider not ready` (ollama) | `OLLAMA_MODEL`의 태그가 설치된 모델과 다름 (예: `llama3.1`로 지정했는데 `llama3.1:8b`만 설치됨). `ollama list`에 보이는 이름 그대로(`OLLAMA_MODEL=llama3.1:8b`) 설정 |
| `claude`가 API 과금을 일으킬까 걱정됨 | `env | grep ANTHROPIC | cut -d= -f1`로 확인하고 `unset ANTHROPIC_API_KEY` |
| 코드 수정 미리보기가 "이 파일에는 비밀 키나 비밀번호로 보이는 내용이 있어서 AI에게 보내지 않았어요"로 거절됨 | 비밀번호·토큰·API 키 같은 이름의 키에 실제 값이 적힌 파일(예: `password: "..."`, `API_KEY=...`)은 안전을 위해 보수적으로 거절함 (값이 무해해 보여도 거절될 수 있음). 값을 환경 변수(`process.env.API_KEY`, `${API_KEY}`)나 비밀 저장소로 옮긴 뒤 다시 요청 |
| "확인을 받아도 보낼 수 없어요" | 비밀 파일 이름이거나 토큰/키 모양 내용이라 `그래도 보내줘`로도 보낼 수 없음. 값을 환경 변수로 옮기거나 다른 파일을 대상으로 지정 |
| 알림 문구를 보냈는데 "알림 기능이 꺼져 있어요" | `.env.local`에 `QUOKY_REMINDERS_ENABLED=false`가 있음 (v3부터 기본은 `true`). 줄을 지우거나 `true`로 바꾸고 재시작 |
| 알림이 DM이 아니라 안 보임 | 알림은 기본으로 소유자 DM으로만 전달. 봇과 DM 창을 한 번 열어 두세요. 채널 전달은 운영자가 `QUOKY_REMINDERS_CHANNEL_DELIVERY=true`로 별도 설정 |
| `내 할 일 보여줘`에 계정 정보(identity)가 설정되어 있지 않다는 안내 | Jira/GitHub 식별자 매핑(`QUOKY_ACTOR_IDENTITY_MAPPINGS`)과 커넥터 자격 증명이 없음. 로컬 할 일은 그대로 동작. 운영자 가이드 참고 |
| `PR 상태 알려줘`가 "현재 PR 상태를 확인하지 못했어요" | GitHub App에 Checks: Read 권한이 없을 수 있음 (운영자 가이드). PR 생성/push에는 영향 없음 |
| push가 "Repository not found"로 실패 | 이전 버전의 알려진 문제(시스템 git credential helper가 앱 토큰을 가림)는 고쳐졌습니다. 그래도 나면 원격이 HTTPS `github.com`인지, GitHub App이 해당 저장소에 설치됐는지 확인 (운영자 가이드) |
| 큰 미리보기가 안 보임 | 봇에 **Attach Files** 권한이 없을 수 있음 (2절 4번) |
| `pnpm install`에서 `better-sqlite3` 빌드 실패 | 네이티브 빌드 도구 설치 (1절) |
| `INSTANCE_ALREADY_RUNNING` | 같은 DB를 쓰는 Quoky 프로세스가 이미 있음. `ops/launchd/quokyctl.sh status`로 서비스를 확인하고 하나만 실행 |
| `INSTANCE_LOCK_UNAVAILABLE` | DB 옆에 잠금 파일을 만들 수 없음. `QUOKY_DB_PATH` 디렉터리와 쓰기 권한 확인 |
| `ENV_FILE_INSECURE` / `ENV_FILE_MISSING` | 서비스용 `.env.local`이 없거나 모드가 600이 아님. `chmod 600 .env.local` 후 `restart --apply` |
| `DISCORD_EXPECTED_BOT_ID_REQUIRED` / `DISCORD_EXPECTED_BOT_ID_INVALID` | 서비스 실행에는 `QUOKY_DISCORD_EXPECTED_BOT_ID`(봇 사용자 ID, 17-20자리)가 필요 |
| `DISCORD_IDENTITY_MISMATCH` | 연결된 봇·서버·허용 채널이 `.env.local`과 다름 (다른 봇의 토큰, 봇이 없는 서버, 볼 수 없는 채널). 고친 뒤 `restart --apply` |
| `DISCORD_IDENTITY_UNVERIFIABLE` | 연결은 됐지만 봇 정보를 읽지 못함 (게이트웨이 준비 지연 등). 서비스는 자동으로 다시 시도 |
| `LAUNCHER_INVALID` | `QUOKY_LAUNCHER`/`QUOKY_LAUNCHER_RECENT_STARTS`는 launcher만 설정함. `.env.local`이나 셸에서 제거 |
| `MEMORY_ARCHIVE_DAYS_INVALID` | `QUOKY_MEMORY_ARCHIVE_DAYS`는 0-365의 정수만. 빈 값도 오류 |
| `LEARNING_EXAMPLES_ENABLED_INVALID`, `CONNECTOR_WRITES_ENABLED_INVALID`, `CALENDAR_WRITE_ENABLED_INVALID` | 해당 변수는 정확히 `true`/`false`만 (또는 줄 삭제) |
| `CONNECTOR_WRITE_JIRA_PROJECTS_INVALID` | 쉼표로 구분한 서로 다른 Jira 프로젝트 키(예: `PROJ,TEST`), 최대 50개 |
| `CONNECTOR_WRITE_SLACK_CHANNELS_INVALID` | `이름:채널ID` 또는 `채널ID` 항목(예: `dev-test:C0123ABCD9`), 중복 없이 최대 50개 |
| `CONNECTOR_WRITE_SLACK_TOKEN_INVALID` / `CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE` | 쓰기 토큰은 Slack **봇** 토큰이어야 하고 읽기용 `QUOKY_SLACK_TOKEN`과 달라야 함 |
| 일정 질문에 캘린더 대신 "내 일정은 볼 수 없다"는 답 | 캘린더가 등록되지 않음: 클라이언트 ID, 비밀, 토큰(파일 또는 값 하나)이 모두 있어야 함. 토큰 파일은 모드 600, 심볼릭 링크 불가 |
| 일정 쓰기 요청에 "읽기만 할 수 있어요" | `QUOKY_CALENDAR_WRITE_ENABLED=true`가 아니거나 토큰에 `calendar.events`가 없음. `--with-events`로 새 토큰 파일을 만들고 경로를 바꿔 재시작 |
| Jira/Slack 쓰기 요청에 "쓰기가 허용된 대상이 아니에요" | 프로젝트 키나 채널이 허용 목록에 없음. 아무것도 보내지 않았음 |
| 운영 화면 로그인에서 "허용되지 않은 출처예요" | 예전 빌드의 알려진 문제(PR #131에서 고침). 최신 빌드로 다시 시작. 주소는 `127.0.0.1` 또는 `localhost`와 설정한 포트만 |
| 운영 화면이 열리지 않음 | `QUOKY_OPS_UI_ENABLED=true`인지, `quoky.log`의 `ops-ui.unavailable reason=...`(포트 사용 중 등) 확인 |
| 이미지에 "분석하지 않았어요" | `ollama`: `QUOKY_OLLAMA_VISION_MODEL`이 비었거나 잘못됐거나, 그 모델이 Ollama에 없음. `claude`: Claude CLI가 없거나 로그인되지 않음(`claude auth status`). 운영 화면 "AI 공급자 준비 상태"의 `IMAGE_UNDERSTANDING` 행과 "이미지 이해 공급자 (설정)" 확인 |
| `IMAGE_UNDERSTANDING_PROVIDER_INVALID` — "QUOKY_IMAGE_UNDERSTANDING_PROVIDER must be unset, "ollama", "claude", or "off" (lowercase). "claude" sends attached images to Anthropic (cloud)." | 소문자 세 값만 허용. 빈 값도 불가 |
| `IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING` / `IMAGE_UNDERSTANDING_OLLAMA_MODEL_INVALID` / `IMAGE_UNDERSTANDING_OLLAMA_MODEL_NOT_LOCAL` | `ollama`를 골랐는데 `QUOKY_OLLAMA_VISION_MODEL`이 없거나 형식이 틀리거나 `cloud` 모델 |
| `IMAGE_UNDERSTANDING_MODEL_INVALID` | `QUOKY_IMAGE_UNDERSTANDING_MODEL` 형식 오류 (`QUOKY_CLAUDE_MODEL`과 같은 규칙) |
| 로그에 `not starting: 3 consecutive configuration exits` | 설정 오류로 3번 연속 멈춰 서비스가 재시작을 멈춤. `quoky.log`에서 원인을 고친 뒤 `ops/launchd/quokyctl.sh restart --apply` |

## 10. 더 알아보기

- 현재 구현 상태: [`CURRENT_STATE.md`](../../CURRENT_STATE.md)
- 결정 기록: [`DECISIONS.md`](../../DECISIONS.md) — ADR-0091 (Discord 소유자 게이트), ADR-0092 (provider/모델),
  ADR-0093 (도움말/새 대화/승인 만료), ADR-0094 (git 안전), Personal v3: ADR-0102 (상시 실행), ADR-0104 (결정적 답),
  ADR-0106 (기억 관리), ADR-0107 (학습), ADR-0110 (캘린더), ADR-0111 (첨부/이미지), ADR-0112 (커넥터 쓰기),
  ADR-0113 (운영 화면)
- Personal v2 Live QA 기록: [`docs/uat/personal-v2-qa-record.md`](../uat/personal-v2-qa-record.md). Jira/Confluence/GitHub
  실제 조회, 알림 채널 전달은 2026-10-06에 실제로 확인했습니다. Slack 읽기 조회와 머지 활성화는 아직 실제 검증 전입니다.
- Personal v3 Live QA 기록: [`docs/uat/personal-v3-qa-record.md`](../uat/personal-v3-qa-record.md). 운영 화면의 처리/승인,
  첨부·이미지, 학습 예시, 한국어 일상 대화 20문항 세트 등 아직 실행하지 않은 항목은 기록 끝의 PENDING 목록에 있습니다.
- 운영자 설정 (환경 변수, GitHub App 권한, 커넥터, Ollama/Claude 격리): [`docs/uat/operator-guide.md`](../uat/operator-guide.md)
- 첫 릴리스 attended Live UAT 절차: [`docs/uat/first-release-uat-packet.md`](../uat/first-release-uat-packet.md)
