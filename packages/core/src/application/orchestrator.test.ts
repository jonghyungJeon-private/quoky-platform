import { describe, expect, it } from 'vitest';
import { InvalidTaskTransitionError } from '../errors';
import type { ConversationContext, InboundMessage, OutboundMessage } from '../domain';
import type { Logger, LogFields, PlatformAdapter } from '../ports';
import { QuokyCore } from './orchestrator';
import type { ConversationRuntime, TurnResult } from './conversation-runtime';

// ── Sprint 4c-Follow-up-7 (F7-D) — QuokyCore backstop ─────────────────────────────────────────────
// Test-only. `ConversationRuntime.handle()` is designed never to throw for an application error, but the
// facade keeps a backstop: if handle() EVER throws, deliver exactly ONE sanitized error response (never a
// raw exception / stack) and keep the runtime alive; a delivery failure is logged only (no recursion). No
// production file is touched by these tests.

const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };
const messageOf = (text: string): InboundMessage => ({ id: 'm-9151', context: CTX, text, receivedAt: '2026-07-01T00:00:00.000Z' });

interface Recorded {
  sends: OutboundMessage[];
  typing: number;
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; fields?: LogFields }>;
}

/** A fake PlatformAdapter recording every delivery. `sendThrows` makes `sendMessage` throw to exercise the
 *  delivery-failure branch. Only the methods the facade calls are meaningfully implemented; the rest satisfy
 *  the port shape and are never invoked on this path. */
function makePlatform(opts: { sendThrows?: boolean } = {}): { platform: PlatformAdapter; rec: Recorded } {
  const rec: Recorded = { sends: [], typing: 0, logs: [] };
  const platform: PlatformAdapter = {
    platform: 'test',
    async start() {},
    async stop() {},
    onMessage() {},
    onApprovalDecision() {},
    async sendMessage(message: OutboundMessage) {
      rec.sends.push(message);
      if (opts.sendThrows) throw new Error('discord 500 token=secret-xyz /abs/path');
    },
    async sendTyping() {
      rec.typing++;
    },
    async requestApproval() {},
  };
  return { platform, rec };
}

function makeLogger(rec: Recorded): Logger {
  return {
    info: (message, fields) => rec.logs.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => rec.logs.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => rec.logs.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
  };
}

/** A fake ConversationRuntime exposing only `handle` (the sole method the facade calls). */
function makeRuntime(handle: (m: InboundMessage) => Promise<TurnResult>): ConversationRuntime {
  return { handle } as unknown as ConversationRuntime;
}

describe('QuokyCore.handleInboundMessage — F7-D backstop', () => {
  it('runtime.handle THROWS → exactly ONE sanitized sendMessage (mapped message + 오류 코드 + conservative MAY_HAVE_APPLIED wording, NEVER a false zero-mutation claim, no raw/stack); method resolves', async () => {
    const { platform, rec } = makePlatform();
    const runtime = makeRuntime(async () => {
      throw new InvalidTaskTransitionError('PENDING', 'RUNNING');
    });
    const core = new QuokyCore({ runtime, platform, logger: makeLogger(rec) });

    // Resolves (does not reject) even though handle() threw.
    await expect(core.handleInboundMessage(messageOf('아무거나'))).resolves.toBeUndefined();

    expect(rec.sends).toHaveLength(1);
    const text = rec.sends[0]!.text;
    expect(text).toContain('작업 상태를 변경하는 과정에서 허용되지 않은 상태 전이가 발생했어요.');
    expect(text).toContain('오류 코드:');
    expect(text).toContain('TASK_TRANSITION_ERROR');
    // The facade backstop cannot prove WHERE the runtime failed, so it must default to "possibly applied":
    // the conservative wording, and NEVER the confirmed "no change applied" line (CA mutation-certainty fix).
    expect(text).toContain('변경 적용 여부를 확인할 수 없어요.');
    expect(text).toContain('추가 작업을 진행하기 전에 현재 상태를 확인해주세요.');
    expect(text).not.toContain('아직 어떤 변경도 적용되지 않았어요.');
    // never the raw exception / stack frame
    expect(text).not.toContain('Illegal task transition: PENDING -> RUNNING');
    expect(text).not.toMatch(/\bat [^\n]*:\d+:\d+/);
    // the full failure is logged internally (backstop), never delivered
    expect(rec.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('runtime.handle throws AND sendMessage ALSO throws → delivery failure logged, NO second sendMessage (no recursion), method still resolves', async () => {
    const { platform, rec } = makePlatform({ sendThrows: true });
    const runtime = makeRuntime(async () => {
      throw new Error('boom');
    });
    const core = new QuokyCore({ runtime, platform, logger: makeLogger(rec) });

    await expect(core.handleInboundMessage(messageOf('아무거나'))).resolves.toBeUndefined();

    // Exactly one delivery attempt — the throwing one — and NO retry (no recursion).
    expect(rec.sends).toHaveLength(1);
    // The delivery failure is logged; its detail must not leak the raw send-error payload as message text.
    const errorLogs = rec.logs.filter((l) => l.level === 'error');
    expect(errorLogs.length).toBeGreaterThanOrEqual(2); // handling-failed + delivery-failed
    expect(errorLogs.some((l) => l.message.includes('delivery'))).toBe(true);
  });

  it('runtime.handle returns normally → sendMessage(result.reply) called exactly once (no error path)', async () => {
    const { platform, rec } = makePlatform();
    const reply: OutboundMessage = { context: CTX, text: '정상 응답이에요.' };
    const runtime = makeRuntime(async () => ({ status: 'RESPONDED', reply, sessionId: 'sess-1' }));
    const core = new QuokyCore({ runtime, platform, logger: makeLogger(rec) });

    await core.handleInboundMessage(messageOf('춘식아 안녕?'));

    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0]).toBe(reply); // the runtime's own reply, unmodified
    expect(rec.sends[0]!.text).toBe('정상 응답이에요.');
    // No error path taken.
    expect(rec.logs.some((l) => l.level === 'error')).toBe(false);
  });
  it('CS-2 rerun: the first reply is delivered, then the rerun message is handled once as a new turn; a rerun carried by the rerun result is never honoured (depth 1)', async () => {
    const { platform, rec } = makePlatform();
    const rerun2 = { ...messageOf('세 번째'), id: 'm-3' };
    const rerun1 = { ...messageOf('두 번째'), id: 'm-2' };
    const seen: string[] = [];
    const runtime = makeRuntime(async (message) => {
      seen.push(message.id);
      const reply: OutboundMessage = { context: CTX, text: `답: ${message.text}` };
      if (message.id === 'm-9151') return { status: 'RESPONDED', reply, sessionId: 's', rerun: rerun1 };
      return { status: 'RESPONDED', reply, sessionId: 's', rerun: rerun2 };
    });
    const core = new QuokyCore({ runtime, platform, logger: makeLogger(rec) });
    await core.handleInboundMessage(messageOf('첫 번째'));
    expect(seen).toEqual(['m-9151', 'm-2']);
    expect(rec.sends.map((m) => m.text)).toEqual(['답: 첫 번째', '답: 두 번째']);
  });

  it('CS-2 rerun: no rerun field, no second turn', async () => {
    const { platform, rec } = makePlatform();
    const calls: string[] = [];
    const runtime = makeRuntime(async (message) => {
      calls.push(message.id);
      return { status: 'RESPONDED', reply: { context: CTX, text: 'x' }, sessionId: 's' };
    });
    await new QuokyCore({ runtime, platform, logger: makeLogger(rec) }).handleInboundMessage(messageOf('a'));
    expect(calls).toEqual(['m-9151']);
  });
});
