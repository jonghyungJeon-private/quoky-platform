import { describe, expect, it } from 'vitest';
import {
  LEARNING_EGRESS_LOCAL_ONLY, LEARNING_MAX_ITEMS_PER_ACTOR, LEARNING_RETENTION_MS, LEARNING_TEXT_MAX_CHARS,
  LearningItemKind, isLearningEgressAllowed, learningLanguageOf,
} from './learning';

describe('learning domain (ADR-0107 D2/D6, owner decision 5)', () => {
  it('pins the ratified bounds: LOCAL_ONLY egress, 365-day retention, 2,000 chars, 1,000 items per actor', () => {
    expect(LEARNING_EGRESS_LOCAL_ONLY).toBe('LOCAL_ONLY');
    expect(LEARNING_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(LEARNING_TEXT_MAX_CHARS).toBe(2000);
    expect(LEARNING_MAX_ITEMS_PER_ACTOR).toBe(1000);
    expect(Object.values(LearningItemKind)).toEqual(['GOLDEN_CANDIDATE', 'EXAMPLE']);
  });

  it('a LOCAL_ONLY item may reach only a provider declaring LOCAL; absent means REMOTE (fail closed)', () => {
    expect(isLearningEgressAllowed(LEARNING_EGRESS_LOCAL_ONLY, 'LOCAL')).toBe(true);
    expect(isLearningEgressAllowed(LEARNING_EGRESS_LOCAL_ONLY, 'REMOTE')).toBe(false);
    expect(isLearningEgressAllowed(LEARNING_EGRESS_LOCAL_ONLY, undefined)).toBe(false);
    expect(isLearningEgressAllowed('ANYWHERE', 'LOCAL')).toBe(false);
  });

  it('tags the request language coarsely', () => {
    expect(learningLanguageOf('내일 회의 몇 시야?')).toBe('ko');
    expect(learningLanguageOf('Summarize this, 요약')).toBe('ko');
    expect(learningLanguageOf('Summarize the notes')).toBe('en');
    expect(learningLanguageOf('12:30 ?')).toBe('und');
  });
});
