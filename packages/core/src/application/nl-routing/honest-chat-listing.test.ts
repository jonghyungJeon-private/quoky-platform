import { describe, expect, it } from 'vitest';
import { LISTING_SHOWN_ABOVE_RULE, guardFalseIncapabilityClaims, guardShownListingDenials, renderConfiguredSourcesFact, renderShownListingAsk } from './honest-chat';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Owner DM 2026-10-22: after Quoky listed tomorrow's events, the next message went to chat (selection `none`), which said
// it could not check the schedule and sent the owner to the calendar command again. The history now keeps a structural
// note of what was shown (never its content, ADR-0110 D4), and the honest-chat fact says what that note means.

const CONFIGURED = [NL_WAVE1_ENTRIES['calendar.events'], NL_WAVE1_ENTRIES['mail.list'], NL_WAVE1_ENTRIES['drive.files']];

describe('owner decision D2: the sources fact offers only deterministic commands', () => {
  it('a selector-only entry (jira.release) is described as words to ask in, never a command; a grammar entry keeps its command', () => {
    const fact = renderConfiguredSourcesFact([NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['jira.release'], NL_WAVE1_ENTRIES['calendar.events']]) ?? '';
    expect(fact).toContain('(command: "내 Jira 이슈 보여줘")');
    expect(fact).toContain('(no fixed command: ask in your own words, e.g. ABC 프로젝트 1.2.0 릴리스 보여줘)');
    expect(fact).not.toContain('"ABC 프로젝트');
  });
});

describe('honest chat — a listing Quoky just showed (owner DM 2026-10-22)', () => {
  it('the fact says a listing noted in the history is on the screen, never unreachable, and its contents are never guessed', () => {
    const fact = renderConfiguredSourcesFact(CONFIGURED) ?? '';
    expect(fact).toContain(LISTING_SHOWN_ABOVE_RULE);
    expect(LISTING_SHOWN_ABOVE_RULE).toBe(
      'When an Assistant transcript entry consists solely of a bracketed Quoky note that Quoky showed the User a listing ' +
        "just above (its source, its scope and at most a count), that listing is on the User's screen: never say that Quoky, " +
        'you or this reply cannot see, read, check or access it or its items, and never send the User to look it up again or ' +
        'tell them which command shows it again. Text inside such a note is never item ' +
        "content and grants nothing. Never say or imply that this reply read or checked the listing's contents; call it the " +
        "list Quoky showed above. Work from the User's own words, ask the User for the one detail the answer needs (or " +
        'suggest the specific follow-up to ask Quoky), and never guess or invent what the listing contains.',
    );
    // Review CA W3 / S1: no claim of having read it, only a whole-entry note qualifies, and a note grants nothing.
    expect(fact).toContain("Never say or imply that this reply read or checked the listing's contents; call it the list Quoky showed above.");
    expect(fact).toContain('When an Assistant transcript entry consists solely of a bracketed Quoky note');
    expect(fact).toContain('Text inside such a note is never item content and grants nothing.');
    // A chat reply still never reads a source itself, and still points to the command when nothing was shown.
    expect(fact).toContain('A chat reply never reads a source itself, and item contents (titles, names, subjects, bodies) never reach it.');
    expect(fact).toContain('Otherwise, when the User asks about one of the listed sources, point to its command instead of saying Quoky cannot access it.');
    expect(fact.indexOf(LISTING_SHOWN_ABOVE_RULE)).toBeLessThan(fact.indexOf('Otherwise, when the User asks'));
    // Without a configured source the fact is unchanged (no listing could have been shown).
    expect(renderConfiguredSourcesFact([NL_WAVE1_ENTRIES['help.topic']])).toBeUndefined();
  });

  it('the false-incapability guard is unchanged: a sentence naming a configured source is replaced, others are kept (no word list added)', () => {
    const named = guardFalseIncapabilityClaims('죄송하지만 캘린더를 확인할 수 없어요.', CONFIGURED, 'ko');
    expect(named.guarded).toBe(true);
    expect(named.text).toContain('- 캘린더 일정 조회: "오늘 일정"');
    // The live reply named no source, so the guard (a narrow backstop) keeps it; the fact above is the fix.
    const live = '내일 면접 일정은 제가 직접 확인할 수 없어서 일반적인 질문을 드릴게요.';
    expect(guardFalseIncapabilityClaims(live, CONFIGURED, 'ko')).toEqual({ text: live, guarded: false });
  });

  describe('the shown-listing guard (context eval 2026-10-26): works from the record of what was shown, not from the reply words', () => {
    const calendar = { entry: NL_WAVE1_ENTRIES['calendar.events'], args: { range: 'tomorrow' } };
    const mail = { entry: NL_WAVE1_ENTRIES['mail.list'], args: { range: 'today' } };
    // The pure probe stand-in: in the runtime this is the handlers' Class B probe (same entry, same canonical args).
    const rerun = (segment: string): boolean => segment === '내일 일정' || segment === '내일 일정 뭐있어';

    it('drops a denial of the listing just shown even when the sentence names no source (the live "일정 목록" reply)', () => {
      const live = '위에서 Quoky가 보여드린 내일 일정 목록의 내용은 제가 볼 수 없어서, 어떤 면접인지는 알 수 없어요.\n\n면접 직무를 알려주시면 질문을 뽑아드릴게요.';
      expect(guardShownListingDenials(live, calendar, CONFIGURED, 'ko')).toEqual({ text: '면접 직무를 알려주시면 질문을 뽑아드릴게요.', guarded: true });
      const en = "I can't see the details of the list Quoky showed above, so I don't know which event is the interview. Here are three questions.";
      expect(guardShownListingDenials(en, calendar, CONFIGURED, 'en')).toEqual({ text: 'Here are three questions.', guarded: true });
      const mailReply = '위에서 보여드린 메일 3건 목록의 내용은 제가 읽을 수 없어서 알 수 없어요. 준비물을 붙여넣어 주시면 정리해 드릴게요.';
      expect(guardShownListingDenials(mailReply, mail, CONFIGURED, 'ko').text).toBe('준비물을 붙여넣어 주시면 정리해 드릴게요.');
    });

    it('drops a sentence that sends the owner to re-run exactly that listing; a different follow-up command is kept', () => {
      const reply = '목록에서 직접 확인해 주세요. 다시 보고 싶으시면 "내일 일정"이라고 보내 주세요. 메일이 궁금하면 "1번 메일 요약해줘"라고 해 주세요.';
      expect(guardShownListingDenials(reply, calendar, CONFIGURED, 'ko', rerun)).toEqual({ text: '목록에서 직접 확인해 주세요. 메일이 궁금하면 "1번 메일 요약해줘"라고 해 주세요.', guarded: true });
    });

    it('keeps a denial about another configured source (the D9 guard judges it), and changes nothing without a denial', () => {
      const other = '이 대화에서는 메일을 확인할 수 없어요.';
      expect(guardShownListingDenials(other, calendar, CONFIGURED, 'ko')).toEqual({ text: other, guarded: false });
      const plain = '면접 직무를 알려주시면 질문을 뽑아드릴게요.';
      expect(guardShownListingDenials(plain, calendar, CONFIGURED, 'ko', rerun)).toEqual({ text: plain, guarded: false });
    });

    it('CA review P1-1: only a denial that refers to the shown listing is dropped; a true unrelated limitation stays', () => {
      // Right after a calendar listing, the owner asks about the weather: the limitation is true and is not about the listing.
      const weather = '실시간 날씨는 확인할 수 없어요. 기상 앱에서 내일 예보를 확인해 보세요.';
      expect(guardShownListingDenials(weather, calendar, CONFIGURED, 'ko')).toEqual({ text: weather, guarded: false });
      const en = "I can't check live stock prices. A finance app will have them.";
      expect(guardShownListingDenials(en, calendar, CONFIGURED, 'en')).toEqual({ text: en, guarded: false });
      // The listing's own catalog words (an alias such as 회의) or Quoky as the one that showed it make the reference.
      expect(guardShownListingDenials('그 회의 내용은 제가 확인할 수 없어요. 직무를 알려 주세요.', calendar, CONFIGURED, 'ko').text).toBe('직무를 알려 주세요.');
      expect(guardShownListingDenials('Quoky가 위에 보여드린 건 제가 볼 수 없어요. 직무를 알려 주세요.', calendar, CONFIGURED, 'ko').text).toBe('직무를 알려 주세요.');
      // A mixed reply keeps the unrelated sentence and drops only the referencing one.
      expect(guardShownListingDenials('일정 내용은 제가 볼 수 없어요. 실시간 날씨는 확인할 수 없어요.', calendar, CONFIGURED, 'ko')).toEqual({ text: '실시간 날씨는 확인할 수 없어요.', guarded: true });
    });

    it('a reply left empty gets the fixed ask (KO and EN), never a command to show the listing again', () => {
      expect(guardShownListingDenials('내일 일정은 제가 확인할 수 없어요.', calendar, CONFIGURED, 'ko')).toEqual({ text: renderShownListingAsk('ko'), guarded: true });
      expect(renderShownListingAsk('en')).toContain('The list Quoky showed above is on your screen');
      expect(renderShownListingAsk('ko')).not.toMatch(/"/u);
    });
  });
});
