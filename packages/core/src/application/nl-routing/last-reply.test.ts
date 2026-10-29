import { describe, expect, it } from 'vitest';
import type { Actor, Session } from '../../domain';
import { LAST_REPLY_METADATA_KEY, LAST_REPLY_TTL_MS, nextLastReply, nlBareYesNo, readClosedQuestion, readLastReply, renderNoOpenQuestion, withLastReply } from './last-reply';
import { CLOSED_QUESTION_FACT } from './honest-chat';
import { NlSelectionService, type NlIntentMode } from './nl-selection-service';

// Owner decision of 2026-10-29: the `quoky.lastReply` record, the bare yes / no test and the fixed notice. The runtime
// interception is driven end to end over the production AppModule in apps/quoky context-eval-runner.app.test.ts.

const T0 = '2026-10-29T03:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

describe('quoky.lastReply record', () => {
  it('reads back per actor within 30 minutes; expired, malformed or another actor counts as absent', () => {
    const value = withLastReply(undefined, 'owner', { chat: false, at: T0 }, T0);
    expect(readLastReply(value, 'owner', T0)).toEqual({ chat: false, at: T0 });
    expect(readLastReply(value, 'owner', at(LAST_REPLY_TTL_MS - 1))).toEqual({ chat: false, at: T0 });
    expect(readLastReply(value, 'owner', at(LAST_REPLY_TTL_MS))).toBeUndefined();
    expect(readLastReply(value, 'owner', at(-1))).toBeUndefined();
    expect(readLastReply(value, 'other', T0)).toBeUndefined();
    expect(readLastReply({ byActor: { owner: { chat: 'no', at: T0 } } }, 'owner', T0)).toBeUndefined();
    expect(readLastReply({ byActor: { owner: { chat: true, at: 'later' } } }, 'owner', T0)).toBeUndefined();
    expect(readLastReply('garbage', 'owner', T0)).toBeUndefined();
  });

  it('replaces this actor, keeps other fresh actors, drops expired ones, and holds no text', () => {
    let value = withLastReply(undefined, 'a', { chat: true, at: T0 }, T0);
    value = withLastReply(value, 'b', { chat: false, at: at(1000) }, at(1000));
    value = withLastReply(value, 'a', { chat: false, at: at(2000) }, at(2000));
    expect(value).toEqual({ byActor: { b: { chat: false, at: at(1000) }, a: { chat: false, at: at(2000) } } });
    const later = withLastReply(value, 'c', { chat: true, at: at(LAST_REPLY_TTL_MS + 1500) }, at(LAST_REPLY_TTL_MS + 1500));
    expect(Object.keys((later as { byActor: object }).byActor)).toEqual(['a', 'c']);
  });

  it('keeps at most 64 actors', () => {
    let value: unknown;
    for (let i = 0; i < 70; i += 1) value = withLastReply(value, `actor-${i}`, { chat: false, at: T0 }, T0);
    const actors = Object.keys((value as { byActor: object }).byActor);
    expect(actors).toHaveLength(64);
    expect(actors).toContain('actor-69');
  });
});

describe('quoky.lastReply questionClosedAt — an open D7 question closed without an answer (owner decision of 2026-10-29, "1번 진행")', () => {
  // One turn's write, as `NlSelectionService.recordLastReply` does it.
  const reply = (current: unknown, actorId: string, chat: boolean, closedQuestion: boolean, now: string) =>
    withLastReply(current, actorId, nextLastReply(current, actorId, chat, closedQuestion, now), now);

  it('is written when the turn that took the open question is answered by chat, and read back for that actor', () => {
    const value = reply(undefined, 'owner', true, true, T0);
    expect(value).toEqual({ byActor: { owner: { chat: true, at: T0, questionClosedAt: T0 } } });
    expect(readClosedQuestion(value, 'owner', T0)).toBe(true);
    expect(readClosedQuestion(value, 'owner', at(60_000))).toBe(true);
  });

  it('is carried by later chat replies, keeping the time of the close', () => {
    let value = reply(undefined, 'owner', true, true, T0);
    value = reply(value, 'owner', true, false, at(60_000));
    value = reply(value, 'owner', true, false, at(120_000));
    expect(readLastReply(value, 'owner', at(120_000))).toEqual({ chat: true, at: at(120_000), questionClosedAt: T0 });
    expect(readClosedQuestion(value, 'owner', at(120_000))).toBe(true);
  });

  it('is never set when the turn that took the question was not chat (an answer, a served command, a new question)', () => {
    expect(reply(undefined, 'owner', false, true, T0)).toEqual({ byActor: { owner: { chat: false, at: T0 } } });
    expect(readClosedQuestion(reply(undefined, 'owner', false, true, T0), 'owner', T0)).toBe(false);
    // A chat turn with no question taken and nothing held sets nothing.
    expect(readClosedQuestion(reply(undefined, 'owner', true, false, T0), 'owner', T0)).toBe(false);
  });

  it('is dropped by any reply that is not chat: a new D7 question, an answer, a served command, a notice or an error', () => {
    const closed = reply(undefined, 'owner', true, true, T0);
    const next = reply(closed, 'owner', false, false, at(1000));
    expect(readLastReply(next, 'owner', at(1000))).toEqual({ chat: false, at: at(1000) });
    expect(readClosedQuestion(next, 'owner', at(1000))).toBe(false);
    // ...and a chat reply after that does not bring it back.
    expect(readClosedQuestion(reply(next, 'owner', true, false, at(2000)), 'owner', at(2000))).toBe(false);
  });

  it('stops applying 30 minutes after the close, even while chat replies keep the record itself fresh', () => {
    let value = reply(undefined, 'owner', true, true, T0);
    value = reply(value, 'owner', true, false, at(LAST_REPLY_TTL_MS - 1000));
    expect(readClosedQuestion(value, 'owner', at(LAST_REPLY_TTL_MS - 1))).toBe(true);
    expect(readClosedQuestion(value, 'owner', at(LAST_REPLY_TTL_MS))).toBe(false);
    // The next chat reply after the TTL does not carry the expired close.
    const after = reply(value, 'owner', true, false, at(LAST_REPLY_TTL_MS + 1000));
    expect(readLastReply(after, 'owner', at(LAST_REPLY_TTL_MS + 1000))).toEqual({ chat: true, at: at(LAST_REPLY_TTL_MS + 1000) });
    // A malformed close time counts as absent.
    expect(readClosedQuestion({ byActor: { owner: { chat: true, at: T0, questionClosedAt: 'soon' } } }, 'owner', T0)).toBe(false);
  });

  it('is scoped per actor: another actor neither sees nor clears it', () => {
    let value = reply(undefined, 'owner', true, true, T0);
    expect(readClosedQuestion(value, 'guest', T0)).toBe(false);
    value = reply(value, 'guest', false, false, at(1000));
    expect(readClosedQuestion(value, 'owner', at(1000))).toBe(true);
    expect(readClosedQuestion(value, 'guest', at(1000))).toBe(false);
  });

  it('holds no content: only booleans and times', () => {
    const value = reply(reply(undefined, 'owner', true, true, T0), 'owner', true, false, at(1000)) as { byActor: Record<string, Record<string, unknown>> };
    expect(Object.keys(value.byActor.owner ?? {}).sort()).toEqual(['at', 'chat', 'questionClosedAt']);
    for (const field of Object.values(value.byActor.owner ?? {})) expect(typeof field === 'boolean' || !Number.isNaN(Date.parse(String(field)))).toBe(true);
  });
});

describe('CLOSED_QUESTION_FACT', () => {
  it('states the close, the missing confirmation, that nothing was held and that a yes confirms nothing; no content', () => {
    expect(CLOSED_QUESTION_FACT).toContain('closed without an answer');
    expect(CLOSED_QUESTION_FACT).toContain('never confirmed');
    expect(CLOSED_QUESTION_FACT).toContain('nothing from it was selected, filled in or held');
    expect(CLOSED_QUESTION_FACT).toContain('A yes, a no or a number sent now does not answer that question');
    // A fixed English sentence: no Hangul, no digit, no quote or code mark (an apostrophe only inside a word), no braces.
    expect(CLOSED_QUESTION_FACT).not.toMatch(/[\p{Script=Hangul}\d"“”‘`{}<>\[\]]|(?<!\p{L})'|'(?!\p{L})/u);
  });
});

describe('nlBareYesNo — the existing closed continuation reply set, whole message only', () => {
  it('a bare yes or no, Korean or English, with trailing punctuation', () => {
    for (const text of ['응', '네', '네.', 'ㅇㅇ', '그래', 'yes', 'OK', 'ok!']) expect(nlBareYesNo(text), text).toBe('approve');
    for (const text of ['아니', '아니요', '아니 취소', 'no', 'No', 'cancel', '취소해줘']) expect(nlBareYesNo(text), text).toBe('deny');
  });

  it('anything more than the bare answer is not one; an undo word is no yes; an attachment is content', () => {
    for (const text of ['응 내일 일정 보여줘', '네 그리고 메일도', 'yes please show my mail', '되돌려줘', '좋은 아침', '1', '']) {
      expect(nlBareYesNo(text), text).toBe('none');
    }
    expect(nlBareYesNo('응', 1)).toBe('none');
  });

  it('is read after the usual input preparation: quoted text is not the owner\'s answer', () => {
    expect(nlBareYesNo('> 프로젝트가 맞나요?\n응')).toBe('approve');
    expect(nlBareYesNo('> 응')).toBe('none');
  });
});

describe('renderNoOpenQuestion', () => {
  it('names no action, no held state, no inability and no command', () => {
    for (const language of ['ko', 'en'] as const) {
      const text = renderNoOpenQuestion(language);
      // An apostrophe inside a word ("There's") is no quote mark.
      expect(text).not.toMatch(/["“”‘`「」]|(?<!\p{L})'|'(?!\p{L})|수\s*없|못\s*해|cannot|can't|unable|했어요|잡아|added|created/u);
    }
    expect(renderNoOpenQuestion('ko')).toBe('지금 답을 기다리는 질문이 없어요. 원하시는 걸 문장으로 말씀해 주세요.');
    expect(renderNoOpenQuestion('en')).toBe("There's no question waiting for an answer. Tell me what you'd like in a sentence.");
  });
});

describe('NlSelectionService.recordLastReply', () => {
  function service(mode: NlIntentMode, failWrite = false) {
    let session: Session = {
      id: 'sess-r',
      actorId: 'owner',
      context: { platform: 'test', channelId: 'dm-1', userId: 'u', direct: true },
      status: 'ACTIVE' as Session['status'],
      createdAt: T0,
      lastActivityAt: T0,
    };
    let writes = 0;
    const warnings: string[] = [];
    const svc = new NlSelectionService({
      mode,
      router: { select: async () => { throw new Error('never selected'); } },
      sessions: {
        async updateMetadataEntry(_ref, key, update) {
          writes += 1;
          if (failWrite) throw new Error('db down');
          const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
          const next = update(metadata[key]);
          if (next === undefined) delete metadata[key];
          else metadata[key] = next;
          session = { ...session, metadata };
          return session;
        },
      },
      actors: { get: async () => null, save: async (actor: Actor) => actor },
      timeZone: 'Asia/Seoul',
      logger: { info: () => undefined, warn: (event) => void warnings.push(event), error: () => undefined },
    });
    return { svc, session: () => session, writes: () => writes, warnings };
  }

  it('writes the content-free record in active, nothing in shadow or off', async () => {
    const active = service('active');
    await active.svc.recordLastReply({ id: 'sess-r' }, 'owner', false, T0);
    expect(active.session().metadata?.[LAST_REPLY_METADATA_KEY]).toEqual({ byActor: { owner: { chat: false, at: T0 } } });
    await active.svc.recordLastReply({ id: 'sess-r' }, 'owner', true, at(1000));
    expect(readLastReply(active.session().metadata?.[LAST_REPLY_METADATA_KEY], 'owner', at(1000))?.chat).toBe(true);
    for (const mode of ['shadow', 'off'] as const) {
      const other = service(mode);
      await other.svc.recordLastReply({ id: 'sess-r' }, 'owner', false, T0);
      await other.svc.recordLastReply({ id: 'sess-r' }, 'owner', true, T0, true);
      expect(other.writes(), mode).toBe(0);
    }
  });

  it('owner decision of 2026-10-29 ("1번 진행"): a chat reply to the turn that took the question writes the close; a non-chat reply drops it', async () => {
    const active = service('active');
    await active.svc.recordLastReply({ id: 'sess-r' }, 'owner', true, T0, true);
    expect(active.session().metadata?.[LAST_REPLY_METADATA_KEY]).toEqual({ byActor: { owner: { chat: true, at: T0, questionClosedAt: T0 } } });
    await active.svc.recordLastReply({ id: 'sess-r' }, 'owner', true, at(1000));
    expect(readClosedQuestion(active.session().metadata?.[LAST_REPLY_METADATA_KEY], 'owner', at(1000))).toBe(true);
    await active.svc.recordLastReply({ id: 'sess-r' }, 'owner', false, at(2000));
    expect(active.session().metadata?.[LAST_REPLY_METADATA_KEY]).toEqual({ byActor: { owner: { chat: false, at: at(2000) } } });
  });

  it('never throws on a failed write', async () => {
    const failing = service('active', true);
    await expect(failing.svc.recordLastReply({ id: 'sess-r' }, 'owner', false, T0)).resolves.toBeUndefined();
    expect(failing.warnings).toEqual(['nl_selection.session_write_failed']);
  });
});
