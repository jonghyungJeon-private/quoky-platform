/**
 * CWR-2 (ADR-0110 amendment): the two field-change shapes of a calendar update, shared by the write classification
 * (`isCalendarWriteRequest`, calendar-question.ts) and the parser (`parseCalendarWriteRequest`, calendar-write-request.ts),
 * so a change the parser can read is also classified as a write (context eval 2026-10-26: the usage copy's own example
 * "내일 3시 회의 제목을 주간 회의로 바꿔줘" fell to chat). One definition, no second phrase set. Pure.
 */

/** "제목을 주간 회의로 바꿔줘": the new title before 으로/로 and a change verb. */
export const CALENDAR_RENAME = /제목\s*(?:을|를)?\s*([\s\S]{1,200}?)\s*(?:으로|로)\s*(?:바꿔|변경\s*해|수정\s*해)/u;
/** "장소를 3층으로 바꿔줘": the new location before 으로/로 and a change verb. */
export const CALENDAR_RELOCATE = /(?:장소|위치)\s*(?:을|를)?\s*([\s\S]{1,200}?)\s*(?:으로|로)\s*(?:바꿔|변경\s*해|수정\s*해|옮겨)/u;
