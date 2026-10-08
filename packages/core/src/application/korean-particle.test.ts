import { describe, expect, it } from 'vitest';
import { endsWithBatchim, withObjectParticle, withTopicParticle } from './korean-particle';

describe('Korean particles by reading (live QA D9)', () => {
  it.each([
    ['댓글', true],
    ['게시', false],
    ['Slack 게시', false],
    ['#0', true], // 영
    ['#1', true], // 일
    ['#2', false], // 이
    ['#3', true], // 삼
    ['#4', false], // 사
    ['#5', false], // 오
    ['#6', true], // 육
    ['#7', true], // 칠
    ['#8', true], // 팔
    ['#9', false], // 구
    ['#99', false], // 구십구
    ['#10', true], // 십
    ['#100', true], // 백
    ['Jira', false],
    ['', false],
  ])('%j ends with a final consonant: %s', (word, expected) => {
    expect(endsWithBatchim(word)).toBe(expected);
  });

  it('attaches the object and topic particles', () => {
    expect(withObjectParticle('알림 #99')).toBe('알림 #99를');
    expect(withObjectParticle('Jira 댓글')).toBe('Jira 댓글을');
    expect(withTopicParticle('알림 #3')).toBe('알림 #3은');
    expect(withTopicParticle('Slack 게시')).toBe('Slack 게시는');
  });
});
