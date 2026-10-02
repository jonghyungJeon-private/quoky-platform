# Quoky Personal v1 빠른 시작

이 문서는 **한 명의 소유자(owner)** 가 자기 컴퓨터에서 Quoky를 Discord 봇으로 돌려 일상 대화, 기억,
로컬 코드 수정 흐름을 쓰는 방법을 설명합니다. 이 문서의 모든 환경 변수, 문구, 안내 메시지는 소스에 실제로
존재하는 값입니다 (`.env.example`, `apps/quoky/src/config.ts`, `apps/quoky/src/bootstrap-preflight.ts`,
`packages/core/src/application/`).

> Quoky Personal v1은 단일 소유자용입니다. 팀/호스팅 사용, GitHub push/PR/merge 자동화는
> 이번 릴리스 범위가 아닙니다 (Personal v2 웨이브 1-4에서 여러 파일/새 파일 변경 세트가 추가됨; 아래 로컬 코드 수정 흐름 참고) (`ROADMAP.md`의 "Deferred from Personal v1" 참조).

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

## 5. Ollama (선택, 기본 사용)

일상 대화(`GENERAL_CHAT`)는 **로컬 Ollama가 준비되어 있으면 Ollama가 먼저** 처리하고, 준비되지 않았으면
**자동으로 Claude로 대체**됩니다. Ollama를 쓰지 않으려면 `.env.local`에 `QUOKY_OLLAMA_ENABLED=false`를
넣으세요 (기본값은 `true`). 코드 분석/리뷰는 이 설정과 상관없이 Claude가 처리합니다. `QUOKY_OLLAMA_ENABLED=true`(기본)이면 요약·문서 분석·읽기 조회도 Ollama가 우선이고, 코드 수정은 Claude가 준비되지 않았을 때 Ollama로 대체될 수 있습니다. 코드 수정을 항상 Claude로만 하려면 `QUOKY_OLLAMA_ENABLED=false`.

```sh
ollama --version
ollama pull llama3.1            # OLLAMA_MODEL 기본값
# 한국어 품질을 높이려면 (제안):
ollama pull qwen2.5:7b          # 그리고 .env.local에 OLLAMA_MODEL=qwen2.5:7b
```

- **Ollama 서버가 실행 중**이어야 하고, `OLLAMA_MODEL`로 지정한 모델이 로컬에 있어야 "준비됨"으로 봅니다.
  준비 여부는 요청 시점에 확인하며(`ollama list`, 결과는 최대 약 30초 캐시), 나중에 서버를 켜거나 모델을 받아도
  재시작 없이 반영됩니다.
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
| `QUOKY_OLLAMA_ENABLED` | 선택. `true`(기본) / `false` 정확히 이 두 값만 |
| `OLLAMA_MODEL` | 선택. 기본 `llama3.1` |
| `QUOKY_CLAUDE_MODEL` | 선택. 기본 `sonnet` |
| `QUOKY_GIT_REMOTE_ENABLED` | 선택. 기본 `false`. 7절의 "원격 git" 참고 |
| `QUOKY_CONTEXT_MAX_TOKENS` | 선택. 대화 한 턴에 넣는 기억/문맥의 추정 토큰 예산. 기본 6000, 최대 200000 |
| `QUOKY_GIT_MERGE_ENABLED` | 선택. 기본 `false`. `true`는 `QUOKY_GIT_REMOTE_ENABLED=true`가 필요 (아니면 `GIT_MERGE_REQUIRES_REMOTE`로 시작 실패). 값을 읽기만 하며 머지는 별도 승인 단계 |
| `QUOKY_WORK_SUMMARY_ENABLED` | 선택. 기본 `true`. 업무 조회 요약 기능이 들어오면 사용. Ollama가 준비되지 않으면 요약이 Claude로 갈 수 있어 사내 커넥터 텍스트가 구독을 통해 이 컴퓨터 밖으로 나갈 수 있음. 정책상 불가하면 `false` |
| `QUOKY_REMINDERS_ENABLED` | 선택. 기본 `false`. 알림 기능 켜기 (현재 소스에서는 값만 읽고, 대화 연결은 이후 웨이브) |
| `QUOKY_REMINDERS_CHANNEL_DELIVERY` | 선택. 기본 `false` = 알림은 소유자 DM으로만 전달. **`true`면 알림을 만든 채널에 보내므로 그 채널의 모든 멤버가 알림 내용을 읽을 수 있음.** 알림이 꺼져 있으면 효과 없음. 일일 브리핑은 항상 DM |
| `QUOKY_TIMEZONE` | 선택. 기본 `Asia/Seoul`. IANA 시간대, 잘못된 값은 시작 실패 |
| `QUOKY_EMBEDDING_ENABLED` | 선택. 기본 `false`. `true`면 기억 회상을 **로컬** Ollama 임베딩으로 재정렬 (실패하면 기존 방식). 모델은 자동으로 받지 않음: 먼저 `ollama pull nomic-embed-text` |
| `QUOKY_EMBEDDING_MODEL` | 선택. 기본 `nomic-embed-text`. 이름 또는 태그에 `cloud`가 들어가면 거부 |
| `QUOKY_EMBEDDING_TIMEOUT_MS` | 선택. 기본 `3000`, 범위 100-30000 |

`QUOKY_OLLAMA_ENABLED`, `QUOKY_CLAUDE_MODEL`, `QUOKY_GIT_REMOTE_ENABLED`, `QUOKY_CONTEXT_MAX_TOKENS`와 위의 Personal v2 변수들은 빈 값(예:
`QUOKY_OLLAMA_ENABLED=`)을 "미설정"으로 보지 않고 시작 오류로 처리합니다. 기본값을 쓰려면 줄을 지우거나 `#`으로
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

### 원격 git은 기본 비활성

- push, 원격 읽기, `main` 동기화, 머지 후 브랜치 정리는 `QUOKY_GIT_REMOTE_ENABLED=false`(기본)에서 git 프로세스나
  자격 증명을 쓰기 전에 거절됩니다. 적용 후 `푸시해줘`를 보내면 "원격 git 작업(push 등)은 Personal v1에서 꺼져
  있어요…" 안내와 함께 로컬 커밋 문구(`커밋해줘`)를 알려 줍니다.
- `main`/`master`(또는 detached HEAD)에서의 커밋은 설정과 상관없이 항상 거절됩니다. 먼저 기능 브랜치로
  체크아웃하세요.
- `QUOKY_GIT_REMOTE_ENABLED=true`로 바꿔도 승인 절차는 우회되지 않습니다. Personal v1의 acceptance 범위에는
  push/PR/merge가 포함되지 않습니다.

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
| 큰 미리보기가 안 보임 | 봇에 **Attach Files** 권한이 없을 수 있음 (2절 4번) |
| `pnpm install`에서 `better-sqlite3` 빌드 실패 | 네이티브 빌드 도구 설치 (1절) |

## 10. 더 알아보기

- 현재 구현 상태: [`CURRENT_STATE.md`](../../CURRENT_STATE.md)
- 결정 기록: [`DECISIONS.md`](../../DECISIONS.md) — ADR-0091 (Discord 소유자 게이트), ADR-0092 (provider/모델),
  ADR-0093 (도움말/새 대화/승인 만료), ADR-0094 (git 안전)
- Personal v2 Live QA 기록: [`docs/uat/personal-v2-qa-record.md`](../uat/personal-v2-qa-record.md). 알림, 업무 대화, 피드백 수집은 이후 웨이브에서 대화에 연결되며 이 문서에 추가됩니다.
- 첫 릴리스 attended Live UAT 절차: [`docs/uat/first-release-uat-packet.md`](../uat/first-release-uat-packet.md)
