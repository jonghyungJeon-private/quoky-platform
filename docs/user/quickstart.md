# Quoky Personal v1 빠른 시작

이 문서는 **한 명의 소유자(owner)** 가 자기 컴퓨터에서 Quoky를 Discord 봇으로 돌려 일상 대화, 기억,
로컬 코드 수정 흐름을 쓰는 방법을 설명합니다. 이 문서의 모든 환경 변수, 문구, 안내 메시지는 소스에 실제로
존재하는 값입니다 (`.env.example`, `apps/quoky/src/config.ts`, `apps/quoky/src/bootstrap-preflight.ts`,
`packages/core/src/application/`).

> Quoky Personal v1은 단일 소유자용입니다. 팀/호스팅 사용, GitHub push/PR/merge 자동화, 새 파일/여러 파일 적용은
> 이번 릴리스 범위가 아닙니다 (`ROADMAP.md`의 "Deferred from Personal v1" 참조).

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
- **경고: 셸에 `ANTHROPIC_API_KEY`가 설정되어 있으면 CLI가 구독 대신 API 과금을 할 수 있습니다.** Quoky를
  시작하는 셸에서는 반드시 해제하세요.

  ```sh
  env | grep ANTHROPIC | cut -d= -f1   # 이름이 보이면
  unset ANTHROPIC_API_KEY
  ```

- Quoky의 Claude 사용량은 **Claude 구독 사용 한도**에 포함됩니다. 코드 분석/수정/리뷰는 항상 Claude를
  사용하므로, 한도가 빠듯하면 일상 대화를 Ollama로 돌리는 것이 도움이 됩니다.
- 모델: `QUOKY_CLAUDE_MODEL` (기본 `sonnet`). 별칭 또는 전체 이름이며 CLI에 `--model`로 전달됩니다.
- effort: 설정하지 않습니다. 작업 종류(capability)에 따라 Quoky가 정한 값이 자동으로 전달됩니다.

## 5. Ollama (선택, 기본 사용)

일상 대화(`GENERAL_CHAT`)는 **로컬 Ollama가 준비되어 있으면 Ollama가 먼저** 처리하고, 준비되지 않았으면
**자동으로 Claude로 대체**됩니다. Ollama를 쓰지 않으려면 `.env.local`에 `QUOKY_OLLAMA_ENABLED=false`를
넣으세요 (기본값은 `true`). 코드 분석/수정/리뷰는 이 설정과 상관없이 Claude가 처리합니다.

```sh
ollama --version
ollama pull llama3.1            # OLLAMA_MODEL 기본값
# 한국어 품질을 높이려면 (제안):
ollama pull qwen2.5:7b          # 그리고 .env.local에 OLLAMA_MODEL=qwen2.5:7b
```

- **Ollama 서버가 실행 중**이어야 하고, `OLLAMA_MODEL`로 지정한 모델이 로컬에 있어야 "준비됨"으로 봅니다.
  준비 여부는 요청 시점에 확인하며(`ollama list`, 결과는 최대 약 30초 캐시), 나중에 서버를 켜거나 모델을 받아도
  재시작 없이 반영됩니다.
- 팁 — 아래는 **Ollama 서버 쪽 환경 변수**입니다 (Quoky의 `.env.local`이 아니라 `ollama serve`를 실행하는
  환경에 설정).
  - `OLLAMA_KEEP_ALIVE`: 모델을 메모리에 얼마나 두는지. 짧게(예: `5m`) 두면 RAM을 더 빨리 돌려받습니다.
  - `OLLAMA_CONTEXT_LENGTH`: 컨텍스트 창 크기(예: `8192`). Quoky의 기본 컨텍스트 예산이 약 6000 토큰
    (`QUOKY_CONTEXT_MAX_TOKENS`, 기본 6000)인데 Ollama 기본 창이 그보다 작을 수 있어, 작으면 기억/이전 대화가
    잘릴 수 있습니다.

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

준비된 provider 중 일상 대화를 처리할 수 있는 것이 하나도 없으면 아래 경고가 나오고 대화는 "AI not configured"로
답합니다.

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
| `도움말` 또는 `/help` | 할 수 있는 일과 사용 문구를 보여 줌. AI 호출 없음 |
| `새 대화` 또는 `/reset` | 지금 대화(세션)를 끝내고 새로 시작. 기다리던 승인 요청은 거절로 처리. 이미 적용한 파일 변경/커밋은 되돌리지 않고, `기억해:`로 저장한 내용은 유지 |

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
- 승인을 기다리는 동안 보낸 다른 메시지는 대화로 가지 않고 "승인을 기다리는 작업이 있어요" 알림(남은 시간
  포함)을 받습니다. 그만두려면 `새 대화`를 보내세요.
- `진행하지 마`처럼 부정된 문구는 승인으로 해석되지 않습니다 (거절로 처리됩니다). 질문, 조건이 붙은 말,
  "먼저 보고…" 같은 보류 표현은 결정으로 보지 않고 다시 묻습니다.

### 로컬 코드 수정 흐름

작업 대상은 컴퓨터에 있는 Git 저장소여야 하고, `pnpm test`가 동작하는 프로젝트를 권장합니다. 처음에는 **버려도
되는 샘플 저장소**로 연습하세요. 한 단계씩 말한 문구 그대로 보내면 됩니다.

| 단계 | 보낼 말 (예) | 결과 |
|---|---|---|
| 1. 프로젝트 등록 | `이 프로젝트 등록해줘: /절대/경로/my-repo` | 절대 경로(2단계 이상)와 `등록`이 있어야 인식 |
| 2. 변경 요청 | `src/target.ts 파일을 수정해줘: ...` 또는 `/preview src/target.ts ...` | 코드 변경 승인 요청 (파일 경로를 함께 적어야 함, 아래 참고) |
| 3. 계획 승인 | `승인` | 파일을 바꾸지 않는 **변경 미리보기(diff)** 가 전송됨 |
| 4. 적용 의사 | `적용해줘` | 적용 전 두 번째 승인 요청. 아직 파일은 그대로 |
| 5. 적용 승인 | `승인` | 패치를 만들 준비 상태 |
| 6. 패치 생성 | `패치 만들어줘` | 패치 미리보기. 아직 파일은 그대로 |
| 7. 파일 적용 | `패치 적용해줘` | 실제 파일 수정 (`파일을 수정했어요: ...`). git 명령, 커밋, 테스트는 실행하지 않음 |
| 8. 검증 | `테스트 실행해줘` 또는 `타입체크 실행해줘` | 등록한 저장소에서 `pnpm test` / `pnpm typecheck` 실행 |
| 9. (선택) 로컬 커밋 | `커밋해줘` -> `승인` -> `커밋 실행` | 로컬 커밋만. `main`/`master` 브랜치에는 커밋하지 않음 |

> **파일 경로 규칙:** 대상 파일 경로는 프로젝트 기준 상대 경로이며 디렉터리를 최소 하나 포함해야 합니다(예: `src/app.ts`). 저장소 루트의 파일(`README.md`, `index.js`)은 Personal v1에서 대상으로 인식되지 않으며, 이 경우 "수정할 파일 경로와 함께 다시 요청해 주세요."라는 안내가 한 번 돌아옵니다. 경로를 포함해 다시 요청하면 됩니다.

> **경고 — 8단계의 `테스트 실행해줘`는 별도 승인 없이 등록한 저장소 체크아웃에서 `pnpm test`를 실행합니다.**
> 신뢰하지 않는 프로젝트나 테스트 스크립트가 위험한 저장소는 등록하지 마세요. 부정문("테스트 실행하지 마")은 실행으로
> 해석되지 않습니다.

### 원격 git은 기본 비활성

- push, 원격 읽기, `main` 동기화, 머지 후 브랜치 정리는 `QUOKY_GIT_REMOTE_ENABLED=false`(기본)에서 git 프로세스나
  자격 증명을 쓰기 전에 거절됩니다.
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
| 로그에 `no ready provider for GENERAL_CHAT ...` / 봇이 "AI not configured"로 답함 | Claude CLI 미설치/미로그인이고 Ollama도 준비 안 됨. `claude --version`, Claude 로그인, Ollama 서버/모델(`ollama list`) 확인 |
| 로그에 `provider not ready` (ollama) | Ollama 서버가 꺼져 있거나 `OLLAMA_MODEL`이 없음. Claude가 준비되어 있으면 자동으로 Claude로 답함 |
| 봇이 아무 답도 안 함 | 보낸 사람이 `QUOKY_DISCORD_OWNER_IDS`에 없거나, 채널이 `QUOKY_DISCORD_CHANNEL_IDS`에 없음 (소유자가 아니면 의도적으로 무응답). 서버를 제한하는 `DISCORD_GUILD_ID`도 확인. MESSAGE CONTENT INTENT 확인 |
| `.env.local`을 고쳤는데 반영이 안 됨 | 같은 이름의 셸 환경 변수가 우선함. `env | grep DISCORD | cut -d= -f1`로 이름 확인 후 `env -u NAME`으로 제거해 실행. 수정 후에는 재시작 필요 |
| "먼저 사용할 프로젝트를 등록해 주세요." | 활성 프로젝트가 없음. `새 대화` 뒤에도 마찬가지. 프로젝트를 다시 등록 |
| 승인 알림만 계속 옴 | 승인 대기 중임. `승인`/`거절`로 답하거나 `새 대화`로 그만둠. 30분 뒤 자동 거절 |
| `claude`가 API 과금을 일으킬까 걱정됨 | `env | grep ANTHROPIC | cut -d= -f1`로 확인하고 `unset ANTHROPIC_API_KEY` |
| 큰 미리보기가 안 보임 | 봇에 **Attach Files** 권한이 없을 수 있음 (2절 4번) |
| `pnpm install`에서 `better-sqlite3` 빌드 실패 | 네이티브 빌드 도구 설치 (1절) |

## 10. 더 알아보기

- 현재 구현 상태: [`CURRENT_STATE.md`](../../CURRENT_STATE.md)
- 결정 기록: [`DECISIONS.md`](../../DECISIONS.md) — ADR-0091 (Discord 소유자 게이트), ADR-0092 (provider/모델),
  ADR-0093 (도움말/새 대화/승인 만료), ADR-0094 (git 안전)
- 첫 릴리스 attended Live UAT 절차: [`docs/uat/first-release-uat-packet.md`](../uat/first-release-uat-packet.md)
