import { describe, expect, it } from 'vitest';
import { parseModelSelectionCommand } from './model-selection-command';

/** ADR-0092 amendment (runtime switching): the owner's model command grammar — whole-message, provider-free. */
describe('parseModelSelectionCommand', () => {
  it.each([
    ['모델 상태', { kind: 'status' }],
    ['  모델   상태  ', { kind: 'status' }],
    ['모델 상태 보여줘', { kind: 'status' }],
    ['/model status', { kind: 'status' }],
    ['/MODEL STATUS', { kind: 'status' }],
    ['모델 목록', { kind: 'list' }],
    ['모델 목록 보여줘', { kind: 'list' }],
    ['/model', { kind: 'list' }],
    ['/model list', { kind: 'list' }],
    ['모델 기본값으로', { kind: 'reset', tier: 'all' }],
    ['모델 기본값으로 돌려줘', { kind: 'reset', tier: 'all' }],
    ['/model reset', { kind: 'reset', tier: 'all' }],
    ['이미지 모델 기본값으로', { kind: 'reset', tier: 'image' }],
    ['/model image reset', { kind: 'reset', tier: 'image' }],
  ] as const)('%s', (text, expected) => {
    expect(parseModelSelectionCommand(text)).toEqual(expected);
  });

  it.each([
    ['모델 변경: codex', 'chat', { kind: 'token', token: 'codex' }],
    ['모델 변경 : codex', 'chat', { kind: 'token', token: 'codex' }],
    ['모델 변경：claude:opus', 'chat', { kind: 'token', token: 'claude:opus' }],
    ['대화 모델 변경: ollama', 'chat', { kind: 'token', token: 'ollama' }],
    ['모델 변경: 2', 'chat', { kind: 'number', number: 2 }],
    ['모델 변경: 2번', 'chat', { kind: 'number', number: 2 }],
    ['/model codex', 'chat', { kind: 'token', token: 'codex' }],
    ['/model claude:opus', 'chat', { kind: 'token', token: 'claude:opus' }],
    ['/model ollama:granite3.3:8b', 'chat', { kind: 'token', token: 'ollama:granite3.3:8b' }],
    ['/model 3', 'chat', { kind: 'number', number: 3 }],
    ['이미지 모델 변경: ollama', 'image', { kind: 'token', token: 'ollama' }],
    ['이미지 모델 변경: off', 'image', { kind: 'token', token: 'off' }],
    ['이미지 모델 변경: 6', 'image', { kind: 'number', number: 6 }],
    ['/model image claude', 'image', { kind: 'token', token: 'claude' }],
  ] as const)('set: %s', (text, tier, choice) => {
    expect(parseModelSelectionCommand(text)).toEqual({ kind: 'set', tier, choice });
  });

  it('explicit but malformed forms are usage, never chat', () => {
    for (const text of ['모델 변경:', '모델 변경: ', '모델 변경: claude opus', '모델 변경: $(rm)', '/model a b', '/model image', '/model image a b', '모델 변경: 0']) {
      expect(parseModelSelectionCommand(text), text).toEqual({ kind: 'usage' });
    }
  });

  it('near-misses and ordinary chat about models fall through', () => {
    for (const text of [
      '모델 변경해야 할까?',
      '모델 변경',
      '모델 상태가 궁금해',
      '모델 목록 좀 정리해줘',
      '어떤 모델이 좋아?',
      'codex로 바꿔줘',
      '모델을 codex로 바꿔줘',
      '이 모델 변경: 계획서 검토',
      '/models',
      '/modeling tips',
      '언어 모델 변경 이력 정리해줘',
      '',
    ]) {
      expect(parseModelSelectionCommand(text), text).toBeNull();
    }
  });
});
