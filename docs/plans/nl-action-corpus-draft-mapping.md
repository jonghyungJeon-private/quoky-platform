# NL action corpus: draft schema and mapping (until the R0 schema lands)

`docs/plans/nl-action-corpus-schema.md` (R0, branch `claude/v5-a6-r0`) had not been committed when these corpora were
written, so both files use the draft shape below. When the R0 schema appears, convert mechanically with the mapping.

Files (in `packages/core/src/application/golden/`, next to `nl-intent.v1.json`):
- `nl-action.v1.json`: NLA-6 action corpus. `{id, utterance, context, expected, tags}`.
- `nl-action-redteam.v1.json`: NLA-7 red-team family. `{id, family, attack, summaryKo, context, content, turns[], expected, tags}`.

## Draft shape
- `context.lastListing`: `{source: todo|reminder|mail|drive, ageMin, items:[{label, id}]}` (label = the number the owner saw; for reminders the display number).
- `context.lastAction`: `{entry, target:{source,label,id}, ageMin}` plus optional flags (`firedSinceAction`, `changedSinceAction`, `oneShotPassed`, `eventGone`, `activeLimitReached`, `undone`).
- `context.pendingQuestion`, `context.openTodos`, `context.contentModePref`, `context.replyToEcho`, `context.targetGone`, `context.caps`, `context.actionSwitch`, `context.channel`: fixtures for the specific cases.
- `expected` is exactly one of:
  - `{entry, args, target?, span?}` where `span` maps an arg name to `[start, end)` offsets in the NFC utterance;
  - `{none: true, reason}`;
  - `{question: {question: <kind>, ...}}` (kinds: `todo-or-reminder`, `payload-required`, `when-missing`, `one-at-a-time`, `content-mode`, `other-source`, `out-of-range`, `expired-listing`, `candidates`, `conflict`, `restate-whole-request`, ...);
  - an entry plus `outcomeReply` when the entry is chosen but execution replies plainly (already done, cannot undo).
- Read negatives expect the READ entry (`todo.list`, `mail.list`, ...), never an A6 entry.
- Ids: `act-<entry>-NNN` (entry paraphrases), `ref-NNN` (references), `neg-NNN` (negatives), `rt-<family>-NNN` (red team).

## Mapping to R0
Map `utterance` to the schema's text field, `context.*` to its Reference-context fixture, `expected.entry|none|question` to its outcome union, and `tags` unchanged. Nothing here encodes a phrase list: no case is a routing rule, only a labelled input.
