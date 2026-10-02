import type { GitBranchResult, GitStatus, RepositoryInfo } from '../../domain';
import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerReply } from '../../ports';
import { isNegated, unnegatedMatch } from '../intent-negation';
import { MAX_OWNER_BRANCH_NAME_LENGTH, isCreatableOwnerBranch, isProtectedBranch } from './branch-name-policy';

/**
 * Owner branch create/switch command (ADR-0099 D4) — a `post-anchor` turn handler (ADR-0096, order 100).
 *
 * Deterministic and provider-free: a pure, anchored, negation-aware grammar ({@link detectGitBranchCommand}), a
 * fixed-copy reply set, and {@link GitBranchTurnHandler}, which preflights through read-only git calls and then
 * performs exactly one local ref operation through the CAP-002 `GitManager` surface. No ApprovalRequest (explicit
 * owner command; local, non-destructive, reversible), no Task, no memory write beyond the runtime's own transcript,
 * no remote ref, no push. The handler never re-anchors: the apply-preview anchor is read-only here, so a create at
 * `WORKSPACE_APPLIED` leaves the anchor exactly as it was and a later "커밋해줘" is evaluated on the new branch.
 *
 * It runs after every `*_PENDING` intercept (a pending approval always captures its turn first) and before the
 * ADR-0043 deny-fragment check and the git-mutating-word reject that would otherwise swallow "브랜치 만들어".
 * Registration happens in the composition root (CODE-5, `features/code-work.providers.ts`).
 */

/** A branch command is a short imperative; anything longer is never claimed (also bounds regex work). */
const MAX_COMMAND_CHARS = 300;

/** Stable registry id of the handler (unique across the turn-handler registry). */
export const GIT_BRANCH_TURN_HANDLER_ID = 'git-branch';
/** `ConversationTurnHandler.order` of the handler within the `post-anchor` stage. */
export const GIT_BRANCH_TURN_HANDLER_ORDER = 100;

/** The help line the handler contributes (ADR-0096 D6); within the composer's 120-character bound. */
export const GIT_BRANCH_HELP_LINE =
  '- 브랜치: "브랜치 만들어줘 feature/x" 또는 "feature/x 브랜치로 전환해줘" (로컬만, main/master 제외)';

// ── grammar ─────────────────────────────────────────────────────────────────────────────────────────────

export type GitBranchAction = 'create' | 'switch';

/**
 * The detected command. `name` is the single raw branch token, NOT yet policy-checked (the handler refuses an
 * invalid name with a precise reason rather than silently ignoring the turn).
 */
export type GitBranchCommand =
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'switch'; readonly name: string }
  /** Delete / rename / force / reset / rebase / merge / push / tag / upstream wording next to a create/switch. */
  | { readonly kind: 'unsupported' }
  /** A create/switch command with no branch token, or with more than one. */
  | { readonly kind: 'usage'; readonly action: GitBranchAction };

const BRANCH_WORD = /브랜치|\bbranch\b/i;
/** A create / switch cue; a cue under negation ("브랜치 만들지 마") never counts. */
const ACTION_CUES: readonly RegExp[] = [
  /만들|생성|새\s*브랜치|\bcreate\b|\bmake\b|\bnew\s+branch\b/i,
  /전환|바꿔|바꾸|이동|\bswitch\b|\bcheckout\b/i,
];
/** Companion wording this command never performs. Checked outside the single branch token. */
const UNSUPPORTED_WORDS =
  /삭제|지워|지우|제거|없애|정리|이름\s*(?:을\s*)?(?:변경|바꿔|바꾸)|리네임|\brename\b|\bdelete\b|\bremove\b|\brm\b|\bprune\b|\bcleanup\b|clean\s*up|(?:^|\s)-{1,2}[a-z]|강제|\bforce(?:d)?\b|리셋|\breset\b|리베이스|\brebase\b|머지|병합|\bmerge\b|푸시|\bpush\b|태그|\btag\b|업스트림|\bupstream\b|트래킹|\btrack(?:ing)?\b/i;

const POLITE = '(?:\\s*(?:줘요?|주세요|줄래요?|봐요?))?';
const CREATE_VERB = `(?:만들어|만들자|생성해|생성)${POLITE}`;
const SWITCH_VERB = `(?:전환해|전환|바꿔|바꾸어|이동해|이동)${POLITE}`;
const PLEASE = '(?:please\\s+)?';

interface StrictMatch {
  readonly kind: GitBranchAction;
  /** Whitespace-separated tokens of the name slot (0 = missing, > 1 = ambiguous). */
  readonly tokens: readonly string[];
}

/** Anchored forms, each capturing only the name slot as `rest`. */
const STRICT_FORMS: ReadonlyArray<{ readonly kind: GitBranchAction; readonly re: RegExp }> = [
  // create — Korean: "브랜치 만들어줘 <name>", "브랜치 생성 <name>", "새 브랜치 <name> [만들어줘]", "<name> 브랜치 만들어줘"
  { kind: 'create', re: new RegExp(`^(?:새\\s*)?브랜치\\s*(?:를|을)?\\s*${CREATE_VERB}\\s+(?<rest>.+)$`, 'i') },
  { kind: 'create', re: new RegExp(`^새\\s*브랜치\\s+(?<rest>.+?)(?:\\s+${CREATE_VERB})?$`, 'i') },
  { kind: 'create', re: new RegExp(`^(?<rest>.+?)\\s*브랜치\\s*(?:를|을)?\\s*${CREATE_VERB}$`, 'i') },
  // create — English
  { kind: 'create', re: new RegExp(`^${PLEASE}(?:create|make)\\s+(?:a\\s+)?(?:new\\s+)?branch(?:\\s+(?:named|called))?\\s+(?<rest>.+)$`, 'i') },
  { kind: 'create', re: new RegExp(`^${PLEASE}branch\\s+create\\s+(?<rest>.+)$`, 'i') },
  // switch — Korean: "<name> 브랜치로 전환해줘 / 바꿔줘", "브랜치 전환 <name>"
  { kind: 'switch', re: new RegExp(`^(?<rest>.+?)\\s*브랜치\\s*(?:로|으로|를|을)?\\s*${SWITCH_VERB}$`, 'i') },
  { kind: 'switch', re: new RegExp(`^브랜치\\s*(?:를|을)?\\s*${SWITCH_VERB}\\s+(?<rest>.+)$`, 'i') },
  // switch — English
  { kind: 'switch', re: new RegExp(`^${PLEASE}switch\\s+to\\s+(?:the\\s+)?branch\\s+(?<rest>.+)$`, 'i') },
  { kind: 'switch', re: new RegExp(`^${PLEASE}branch\\s+switch\\s+(?<rest>.+)$`, 'i') },
];

/** A command word with no name at all ("브랜치 만들어줘", "create a branch"). */
const NAMELESS_FORMS: ReadonlyArray<{ readonly kind: GitBranchAction; readonly re: RegExp }> = [
  { kind: 'create', re: new RegExp(`^(?:새\\s*)?브랜치\\s*(?:를|을)?\\s*${CREATE_VERB}$`, 'i') },
  { kind: 'create', re: new RegExp(`^${PLEASE}(?:create|make)\\s+(?:a\\s+)?(?:new\\s+)?branch$`, 'i') },
  { kind: 'switch', re: new RegExp(`^(?:브랜치\\s*(?:를|을|로|으로)?\\s*${SWITCH_VERB})$`, 'i') },
  { kind: 'switch', re: new RegExp(`^${PLEASE}switch\\s+(?:to\\s+)?(?:a\\s+|the\\s+)?branch$`, 'i') },
];

/** Quotes and backticks around a token are allowed; they are replaced by spaces so the token stays exact. */
function normalize(text: string): string {
  return text
    .replace(/[`'"‘’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?~。！？]+$/u, '')
    .trim();
}

/** True when a create/switch cue sits in a negated clause ("… 하지만 지금은 만들지 마" is never a command). */
function hasNegatedCue(n: string): boolean {
  for (const cue of ACTION_CUES) {
    const re = new RegExp(cue.source, cue.flags.includes('g') ? cue.flags : `${cue.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(n)) !== null) {
      if (isNegated(n, m.index, m[0].length)) return true;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return false;
}

function matchStrict(n: string): StrictMatch | null {
  for (const form of NAMELESS_FORMS) {
    if (form.re.test(n)) return { kind: form.kind, tokens: [] };
  }
  for (const form of STRICT_FORMS) {
    const m = form.re.exec(n);
    const rest = m?.groups?.rest;
    if (rest !== undefined) {
      const tokens = rest.trim().split(' ').filter((t) => t.length > 0);
      return { kind: form.kind, tokens };
    }
  }
  return null;
}

/**
 * Detect an owner branch command (ADR-0099 D4). Anchored grammar:
 *  - create: `브랜치 만들어줘 <name>`, `<name> 브랜치 만들어줘`, `브랜치 생성 <name>`, `새 브랜치 <name>`,
 *    `create branch <name>`, `branch create <name>`
 *  - switch: `<name> 브랜치로 전환해줘`, `<name> 브랜치로 바꿔줘`, `브랜치 전환 <name>`, `switch to branch <name>`,
 *    `branch switch <name>`
 *
 * Exactly one branch token (quotes or backticks allowed). Negation-aware via `intent-negation`, so "브랜치 만들지 마"
 * is `null`. Delete/rename/force/reset/rebase/merge/push/tag/upstream wording alongside a create/switch cue is
 * `unsupported`. The post-merge "브랜치 정리/삭제해줘" cleanup phrases carry no create/switch cue and never match.
 * Free chat and questions about branches fall through (`null`).
 */
export function detectGitBranchCommand(text: string): GitBranchCommand | null {
  if (typeof text !== 'string') return null;
  const n = normalize(text);
  if (n.length === 0 || n.length > MAX_COMMAND_CHARS) return null;
  if (!BRANCH_WORD.test(n)) return null;
  if (!unnegatedMatch(n, ACTION_CUES) || hasNegatedCue(n)) return null;

  const strict = matchStrict(n);
  if (strict && strict.tokens.length === 1) {
    const name = strict.tokens[0]!;
    // A flag-shaped token ("-D") is companion wording, never a branch name.
    return name.startsWith('-') ? { kind: 'unsupported' } : { kind: strict.kind, name };
  }
  // Fallback shapes (missing/extra token, or wording the strict grammar does not cover). A question is never a
  // command, so these two outcomes are suppressed for it.
  if (/[?？]/.test(text)) return null;
  if (unnegatedMatch(n, [UNSUPPORTED_WORDS])) return { kind: 'unsupported' };
  if (strict) return { kind: 'usage', action: strict.kind };
  return null;
}

/** Delete / cleanup cue for an explicit branch-removal request (never a create/switch command). */
const DELETE_CUES: readonly RegExp[] = [/삭제|지워|지우|제거|없애|정리|\bdelete\b|\bremove\b|\bprune\b|clean\s*up|\bcleanup\b/i];
/** `git branch -d/-D/--delete <name>` typed as a command. */
const GIT_BRANCH_DELETE_COMMAND = /^git\s+branch\s+(?:-{1,2}d(?:elete)?|-{1,2}force\s+-{1,2}d(?:elete)?)\s+\S+$/i;
/** A question / how-to / hypothetical about deleting is never a delete request. */
const DELETE_QUESTION_WORDS =
  /뭐|무엇|어떻게|어떤|왜|방법|알려|설명|차이|되나|될까|돼\??$|하면|하려면|하는\s*법|\bhow\b|\bwhat\b|\bwhy\b|\bcan\b|\bshould\b|\bif\b|\bwhen\b/i;
const MAX_DELETE_REQUEST_CHARS = 120;

/**
 * Detect an explicit owner branch DELETE / cleanup request ("브랜치 삭제해줘 feature/x", "feature/x 브랜치 지워줘",
 * "delete branch feature/x", `git branch -D feature/x`). Consulted by the handler ONLY after {@link detectGitBranchCommand}
 * returned null and only when the anchor is not in the post-merge cleanup chain (which owns "브랜치 정리해줘" via the
 * runtime's own cleanup flow). Questions, negations and long free text are never a request.
 */
export function detectGitBranchDeleteRequest(text: string): boolean {
  if (typeof text !== 'string') return false;
  const n = normalize(text);
  if (n.length === 0 || n.length > MAX_DELETE_REQUEST_CHARS) return false;
  if (/[?？]/.test(text) || DELETE_QUESTION_WORDS.test(n)) return false;
  if (GIT_BRANCH_DELETE_COMMAND.test(n)) return true;
  if (!BRANCH_WORD.test(n)) return false;
  return unnegatedMatch(n, DELETE_CUES);
}

// ── fixed replies ───────────────────────────────────────────────────────────────────────────────────────

export type GitBranchRefusalReason =
  | 'invalid-name'
  | 'protected-name'
  | 'create-flow-active'
  | 'switch-pending-change'
  | 'dirty-tree'
  | 'branch-exists'
  | 'branch-missing'
  | 'already-current'
  | 'detached-head'
  | 'unborn-repository'
  | 'not-a-repository'
  | 'operation-in-progress';

const NOTHING_CHANGED = '브랜치는 바꾸지 않았어요.';
const LOCAL_ONLY = '원격에는 아무것도 보내지 않았어요.';

const REFUSAL_TEXT: Readonly<Record<GitBranchRefusalReason, (name: string) => string>> = {
  'invalid-name': () =>
    `브랜치 이름은 영문, 숫자와 . _ / - 만 쓸 수 있고 ${MAX_OWNER_BRANCH_NAME_LENGTH}자 이하여야 해요. 예: "브랜치 만들어줘 feature/my-work"\n${NOTHING_CHANGED}`,
  'protected-name': () => `main/master 이름은 만들거나 전환 대상으로 쓰지 않아요. 작업용 이름(예: feature/…)을 알려 주세요.\n${NOTHING_CHANGED}`,
  'create-flow-active': () =>
    `커밋 승인 이후 단계(커밋·푸시·PR 진행 중이거나 마무리된 작업)에서는 브랜치를 만들거나 바꾸지 않아요. 지금 작업을 마무리하거나 새 작업을 시작한 뒤 다시 요청해 주세요.\n${NOTHING_CHANGED}`,
  'switch-pending-change': () =>
    `패치가 준비됐거나 적용된 변경이 있어서 브랜치를 전환하지 않아요. 변경을 이어서 쓰려면 "브랜치 만들어줘 feature/x"로 새 브랜치를 만들 수 있어요.\n${NOTHING_CHANGED}`,
  'dirty-tree': () =>
    `커밋하지 않은 변경이 있어서 전환하지 않았어요. 변경을 커밋하거나 정리한 뒤 다시 요청해 주세요.\n${NOTHING_CHANGED}`,
  'branch-exists': (name) => `\`${name}\` 브랜치가 이미 있어요. 전환하려면 "${name} 브랜치로 전환해줘"라고 요청해 주세요.\n${NOTHING_CHANGED}`,
  'branch-missing': (name) =>
    `\`${name}\` 브랜치를 찾지 못했어요. 새로 만들려면 "브랜치 만들어줘 ${name}"라고 요청해 주세요. (로컬 브랜치만 전환해요)\n${NOTHING_CHANGED}`,
  'already-current': (name) => `이미 \`${name}\` 브랜치에 있어요. 아무것도 바꾸지 않았어요.`,
  'detached-head': () => `지금은 특정 브랜치가 아니라 분리된 HEAD 상태라서 브랜치를 만들거나 바꾸지 않아요.\n${NOTHING_CHANGED}`,
  'unborn-repository': () => `아직 커밋이 하나도 없는 저장소라서 브랜치를 만들 수 없어요.\n${NOTHING_CHANGED}`,
  'not-a-repository': () => `이 프로젝트는 git 저장소가 아니라서 브랜치를 만들거나 바꿀 수 없어요.\n${NOTHING_CHANGED}`,
  'operation-in-progress': () => `병합 충돌이나 진행 중인 git 작업이 있어서 브랜치를 만들거나 바꾸지 않아요.\n${NOTHING_CHANGED}`,
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export const gitBranchReplies = {
  refused: (reason: GitBranchRefusalReason, name: string): string => REFUSAL_TEXT[reason](name),
  created: (from: string, result: GitBranchResult): string =>
    `새 브랜치를 만들고 전환했어요: \`${result.branch}\`\n${from} → ${result.branch} (HEAD ${shortSha(result.headSha)})\n파일 변경은 건드리지 않았어요. ${LOCAL_ONLY} 커밋·푸시도 하지 않았어요.`,
  switched: (from: string, result: GitBranchResult): string =>
    `브랜치를 전환했어요: \`${result.branch}\`\n${from} → ${result.branch} (HEAD ${shortSha(result.headSha)})\n파일 변경은 건드리지 않았어요. ${LOCAL_ONLY}`,
  unsupported: (): string =>
    '브랜치는 만들기("브랜치 만들어줘 feature/x")와 전환("feature/x 브랜치로 전환해줘")만 지원해요. 삭제·이름 변경·강제 변경·리셋·리베이스·병합·푸시·태그·업스트림 설정은 하지 않았어요.\n' +
    NOTHING_CHANGED,
  deleteUnsupported: (): string =>
    '채팅으로는 브랜치를 삭제하지 않아요. 로컬 브랜치 정리는 PR을 머지하고 main을 동기화한 뒤 이어지는 단계("브랜치 정리해줘")에서만 할 수 있어요.\n' +
    '브랜치를 삭제하거나 바꾸지 않았고 git도 실행하지 않았어요.',
  usage: (action: GitBranchAction): string =>
    (action === 'create'
      ? '만들 브랜치 이름을 하나만 알려 주세요. 예: "브랜치 만들어줘 feature/x"'
      : '전환할 브랜치 이름을 하나만 알려 주세요. 예: "feature/x 브랜치로 전환해줘"') + `\n${NOTHING_CHANGED}`,
  noProject: (): string =>
    '브랜치 작업을 하려면 먼저 사용할 프로젝트를 등록해 주세요. (예: "이 프로젝트 등록해줘: /path/to/project")',
  failed: (action: GitBranchAction): string =>
    `브랜치를 ${action === 'create' ? '만들지' : '전환하지'} 못했거나 결과를 확인하지 못했어요. 현재 상태는 "git 상태"로 확인해 주세요.`,
} as const;

// ── handler ─────────────────────────────────────────────────────────────────────────────────────────────

/** The narrow CAP-002 surface the handler needs (a `GitManager` satisfies it structurally). */
export interface GitBranchTurnHandlerGit {
  info(rootPath: string): Promise<RepositoryInfo>;
  status(rootPath: string): Promise<GitStatus>;
  getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null>;
  createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult>;
  switchBranch(rootPath: string, branch: string): Promise<GitBranchResult>;
}

export interface GitBranchTurnHandlerDeps {
  readonly git: GitBranchTurnHandlerGit;
  readonly logger?: Logger;
}

/** Anchor statuses (plain strings, ADR-0096 D1) from which a branch may be created / switched. */
const CREATE_ANCHOR_STATUSES: ReadonlySet<string> = new Set(['ELIGIBLE', 'APPROVED', 'PATCH_READY', 'WORKSPACE_APPLIED']);
const SWITCH_ANCHOR_STATUSES: ReadonlySet<string> = new Set(['ELIGIBLE', 'APPROVED']);
const PENDING_CHANGE_ANCHOR_STATUSES: ReadonlySet<string> = new Set(['PATCH_READY', 'WORKSPACE_APPLIED']);
/** Post-merge chain states whose runtime flow owns "브랜치 정리/삭제해줘" (local/remote cleanup) — never claimed here. */
const CLEANUP_CHAIN_ANCHOR_STATUSES: ReadonlySet<string> = new Set([
  'MAIN_SYNCED',
  'BRANCH_CLEANED',
  'REMOTE_BRANCH_CLEANUP_PENDING',
  'REMOTE_BRANCH_CLEANUP_APPROVED',
  'REMOTE_BRANCH_CLEANED',
]);

export class GitBranchTurnHandler implements ConversationTurnHandler {
  readonly id = GIT_BRANCH_TURN_HANDLER_ID;
  readonly stage = 'post-anchor' as const;
  readonly order = GIT_BRANCH_TURN_HANDLER_ORDER;
  readonly helpLines: readonly string[] = [GIT_BRANCH_HELP_LINE];

  constructor(private readonly deps: GitBranchTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const command = detectGitBranchCommand(ctx.message.text);
    const reply = (text: string, status?: 'FAILED'): TurnHandlerReply => ({
      reply: { context: ctx.message.context, text },
      ...(status ? { status } : {}),
    });
    if (!command) {
      // An explicit branch delete request is answered with a fixed refusal (no git call) instead of reaching chat.
      const status = ctx.applyAnchor?.status;
      if (detectGitBranchDeleteRequest(ctx.message.text) && !(status !== undefined && CLEANUP_CHAIN_ANCHOR_STATUSES.has(status))) {
        return reply(gitBranchReplies.deleteUnsupported());
      }
      return null;
    }

    if (command.kind === 'unsupported') return reply(gitBranchReplies.unsupported());
    if (command.kind === 'usage') return reply(gitBranchReplies.usage(command.action));

    const { kind, name } = command;
    // Pure refusals first: they need neither a workspace nor any git call.
    if (isProtectedBranch(name)) return reply(gitBranchReplies.refused('protected-name', name));
    if (!isCreatableOwnerBranch(name)) return reply(gitBranchReplies.refused('invalid-name', name));
    const anchorStatus = ctx.applyAnchor?.status;
    if (anchorStatus !== undefined) {
      if (kind === 'create' && !CREATE_ANCHOR_STATUSES.has(anchorStatus)) {
        return reply(gitBranchReplies.refused('create-flow-active', name));
      }
      if (kind === 'switch' && !SWITCH_ANCHOR_STATUSES.has(anchorStatus)) {
        return reply(
          gitBranchReplies.refused(PENDING_CHANGE_ANCHOR_STATUSES.has(anchorStatus) ? 'switch-pending-change' : 'create-flow-active', name),
        );
      }
    }

    const workspace = ctx.applyAnchor?.workspaceRef ?? (await ctx.resolveActiveWorkspace());
    if (!workspace) return reply(gitBranchReplies.noProject());
    const rootPath = workspace.rootPath;

    let mutationAttempted = false;
    try {
      const info = await this.deps.git.info(rootPath);
      if (!info.isRepository) return reply(gitBranchReplies.refused('not-a-repository', name));
      if (info.detached || info.branch.trim() === '') return reply(gitBranchReplies.refused('detached-head', name));
      const status = await this.deps.git.status(rootPath);
      if (status.hasUnmergedPaths) return reply(gitBranchReplies.refused('operation-in-progress', name));
      const existing = await this.deps.git.getLocalRefCommit(rootPath, name);

      if (kind === 'create') {
        if (existing) return reply(gitBranchReplies.refused('branch-exists', name));
        if (!info.headSha) return reply(gitBranchReplies.refused('unborn-repository', name));
        mutationAttempted = true;
        const result = await this.deps.git.createBranch(rootPath, name, info.headSha);
        return reply(gitBranchReplies.created(info.branch, result));
      }

      if (info.branch === name) return reply(gitBranchReplies.refused('already-current', name));
      if (!existing) return reply(gitBranchReplies.refused('branch-missing', name));
      if (!status.clean) return reply(gitBranchReplies.refused('dirty-tree', name));
      mutationAttempted = true;
      const result = await this.deps.git.switchBranch(rootPath, name);
      return reply(gitBranchReplies.switched(info.branch, result));
    } catch (err) {
      this.deps.logger?.warn('git branch command failed', {
        action: kind,
        stage: mutationAttempted ? 'mutation' : 'preflight',
        sessionId: ctx.session.id,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      // A preflight read failure changed nothing; a failure after the ref operation started may have changed
      // the checkout, so the copy never claims either way.
      return reply(gitBranchReplies.failed(kind), 'FAILED');
    }
  }
}
