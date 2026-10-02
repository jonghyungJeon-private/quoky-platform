import { describe, expect, it } from 'vitest';
import { FEEDBACK_FINGERPRINT_MAX_ENTRIES, FeedbackSignalKind } from '../../domain';
import type { ConversationTurnRecord } from '../../domain';
import {
  FEEDBACK_SUMMARY_PHRASE, IMPLICIT_CORRECTION_WINDOW_MS, IMPLICIT_REPHRASE_MIN_JACCARD, IMPLICIT_REPHRASE_WINDOW_MS,
  IMPLICIT_RESET_WINDOW_MS, detectFeedbackTurnControl, detectImplicitSignals, fingerprintJaccard, isCorrectionMessage,
  requestFingerprint,
} from './implicit-feedback';

function previousTurn(overrides: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    id: 'turn-prev',
    platform: 'discord',
    channelId: 'c1',
    inboundMessageId: 'm-prev',
    platformUserId: 'u1',
    status: 'RESPONDED',
    createdAt: '2026-10-02T00:00:00.000Z',
    latencyMs: 1000,
    replyChars: 42,
    requestFingerprint: requestFingerprint('alpha beta gamma delta'),
    platformMessageIds: ['r1'],
    ...overrides,
  };
}

const words = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('implicit feedback windows (ADR-0098 D5)', () => {
  it('exports the 120 s / 300 s / 120 s windows and the 0.5 Jaccard threshold', () => {
    expect(IMPLICIT_RESET_WINDOW_MS).toBe(120_000);
    expect(IMPLICIT_CORRECTION_WINDOW_MS).toBe(300_000);
    expect(IMPLICIT_REPHRASE_WINDOW_MS).toBe(120_000);
    expect(IMPLICIT_REPHRASE_MIN_JACCARD).toBe(0.5);
  });

  it('a reset 119 s after a RESPONDED reply is a signal; 121 s is not', () => {
    const base = { previous: previousTurn(), currentText: '새 대화', currentStatus: 'RESPONDED' as const, currentHasWorkFacts: false };
    expect(detectImplicitSignals({ ...base, elapsedMs: 119_000 })).toEqual([FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY]);
    expect(detectImplicitSignals({ ...base, elapsedMs: 120_000 })).toEqual([FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY]);
    expect(detectImplicitSignals({ ...base, elapsedMs: 121_000 })).toEqual([]);
    expect(detectImplicitSignals({ ...base, currentText: '/RESET', elapsedMs: 1_000 }))
      .toEqual([FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY]);
  });

  it('a reset after a non-RESPONDED or control turn is not a signal', () => {
    const base = { currentText: '새 대화', currentStatus: 'RESPONDED' as const, currentHasWorkFacts: false, elapsedMs: 1_000 };
    expect(detectImplicitSignals({ ...base, previous: previousTurn({ status: 'FAILED' }) })).toEqual([]);
    expect(detectImplicitSignals({ ...base, previous: previousTurn({ control: 'help' }) })).toEqual([]);
    expect(detectImplicitSignals({ ...base, previous: null })).toEqual([]);
  });

  it('matches the KO/EN correction lexicon within 300 s', () => {
    for (const text of [
      '아니, 그거 말고', '아니요 다시 해줘', '그게 아니라 저거', '그게아니고', '틀렸어', '잘못 이해했네', '잘못알아들었어',
      'No, I meant the other one', "no that's not it", "That's wrong", 'thats not what I asked',
    ]) {
      expect(isCorrectionMessage(text), text).toBe(true);
      expect(detectImplicitSignals({
        previous: previousTurn(), currentText: text, currentStatus: 'RESPONDED', currentHasWorkFacts: false, elapsedMs: 299_000,
      }), text).toEqual([FeedbackSignalKind.IMPLICIT_CORRECTION]);
    }
    for (const text of ['아니메 추천해줘', '이거 잘 했어', 'nothing to add', 'yes that is right', '새 기능 만들어줘']) {
      expect(isCorrectionMessage(text), text).toBe(false);
    }
    expect(detectImplicitSignals({
      previous: previousTurn(), currentText: '틀렸어', currentStatus: 'RESPONDED', currentHasWorkFacts: false, elapsedMs: 301_000,
    })).toEqual([]);
  });

  it('rephrase needs Jaccard >= 0.5: just below 0.5 (21/43 ≈ 0.49) is not a signal, exactly 0.5 is', () => {
    expect(fingerprintJaccard(words('a', 49), [...words('a', 49), ...words('b', 51)])).toBeCloseTo(0.49, 5);
    const shared = words('w', 21);
    const below = { previous: previousTurn({ requestFingerprint: requestFingerprint([...shared, ...words('x', 11)].join(' ')) }) };
    const belowText = [...shared, ...words('y', 11)].join(' ');
    expect(requestFingerprint(belowText)).toHaveLength(FEEDBACK_FINGERPRINT_MAX_ENTRIES);
    expect(fingerprintJaccard(below.previous.requestFingerprint, requestFingerprint(belowText))).toBeCloseTo(21 / 43, 10);
    expect(detectImplicitSignals({
      ...below, currentText: belowText, currentStatus: 'RESPONDED', currentHasWorkFacts: true, elapsedMs: 10_000,
    })).toEqual([]);

    const half = { previous: previousTurn({ requestFingerprint: requestFingerprint('readme summary') }) };
    expect(fingerprintJaccard(half.previous.requestFingerprint, requestFingerprint('readme'))).toBe(0.5);
    expect(detectImplicitSignals({
      ...half, currentText: 'README', currentStatus: 'RESPONDED', currentHasWorkFacts: true, elapsedMs: 10_000,
    })).toEqual([FeedbackSignalKind.IMPLICIT_REPHRASE]);
  });

  it('rephrase needs a work turn and the 120 s window', () => {
    const input = {
      previous: previousTurn(), currentText: 'alpha beta gamma delta', currentStatus: 'RESPONDED' as const, elapsedMs: 10_000,
    };
    expect(detectImplicitSignals({ ...input, currentHasWorkFacts: true })).toEqual([FeedbackSignalKind.IMPLICIT_REPHRASE]);
    expect(detectImplicitSignals({ ...input, currentHasWorkFacts: false })).toEqual([]);
    expect(detectImplicitSignals({ ...input, currentHasWorkFacts: true, elapsedMs: 121_000 })).toEqual([]);
  });

  it('an approval re-prompt is AWAITING_APPROVAL → AWAITING_APPROVAL by status only', () => {
    const previous = previousTurn({ status: 'AWAITING_APPROVAL' });
    expect(detectImplicitSignals({
      previous, currentText: '응', currentStatus: 'AWAITING_APPROVAL', currentHasWorkFacts: false, elapsedMs: 900_000,
    })).toEqual([FeedbackSignalKind.IMPLICIT_APPROVAL_REPROMPT]);
    expect(detectImplicitSignals({
      previous, currentText: '승인', currentStatus: 'RESPONDED', currentHasWorkFacts: false, elapsedMs: 1_000,
    })).toEqual([]);
    expect(detectImplicitSignals({
      previous: previousTurn(), currentText: '응', currentStatus: 'AWAITING_APPROVAL', currentHasWorkFacts: false, elapsedMs: 1_000,
    })).toEqual([]);
  });

  it('rejects a negative or non-finite elapsed time', () => {
    const base = { previous: previousTurn(), currentText: '새 대화', currentStatus: 'RESPONDED' as const, currentHasWorkFacts: false };
    expect(detectImplicitSignals({ ...base, elapsedMs: -1 })).toEqual([]);
    expect(detectImplicitSignals({ ...base, elapsedMs: Number.NaN })).toEqual([]);
  });
});

describe('request fingerprint and control detection', () => {
  it('is 8-hex keyword hashes, deduplicated, bounded to 32, and never contains the keywords', () => {
    const fingerprint = requestFingerprint('Secret-Project secret project 프로젝트');
    expect(fingerprint).toHaveLength(3);
    for (const entry of fingerprint) expect(entry).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint.join(' ')).not.toMatch(/secret|project|프로젝트/i);
    expect(requestFingerprint(words('k', 50).join(' '))).toHaveLength(FEEDBACK_FINGERPRINT_MAX_ENTRIES);
    expect(requestFingerprint('   ')).toEqual([]);
  });

  it('classifies help, reset and the exact `피드백 요약` phrase as control turns', () => {
    expect(detectFeedbackTurnControl('도움말')).toBe('help');
    expect(detectFeedbackTurnControl(' 새 대화 ')).toBe('reset');
    expect(detectFeedbackTurnControl(FEEDBACK_SUMMARY_PHRASE)).toBe('feedback-summary');
    expect(detectFeedbackTurnControl('  피드백 요약  ')).toBe('feedback-summary');
    expect(detectFeedbackTurnControl('피드백 요약해줘')).toBeUndefined();
    expect(detectFeedbackTurnControl('/feedback')).toBeUndefined();
  });
});
