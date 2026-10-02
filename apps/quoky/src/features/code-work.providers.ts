import type { Provider } from '@nestjs/common';
import { GitBranchTurnHandler, GitManager } from '@quoky/core';
import type { ConversationTurnHandler } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import { CODE_WORK_TURN_HANDLERS } from './feature-tokens';

/**
 * Code-work branch commands (ADR-0099 D4) — feature composition (ADR-0096 D7, registered by CODE-5).
 *
 * `CODE_WORK_TURN_HANDLERS` carries the `post-anchor` `GitBranchTurnHandler` (order 100), built from the composed
 * CAP-002 `GitManager` — so every branch create/switch runs through the same `GIT_PROVIDER` chain as commit and
 * push, outermost the `PersonalGitGuard` (main/master never created; local-only, works with remote off). The handler
 * contributes its own help line; it never creates an ApprovalRequest, a Task or a remote ref.
 */
const codeWorkLogger = new ConsoleLogger('code-work');

export const codeWorkProviders: Provider[] = [
  {
    provide: CODE_WORK_TURN_HANDLERS,
    useFactory: (git: GitManager): readonly ConversationTurnHandler[] => [
      new GitBranchTurnHandler({ git, logger: codeWorkLogger }),
    ],
    inject: [GitManager],
  },
];
