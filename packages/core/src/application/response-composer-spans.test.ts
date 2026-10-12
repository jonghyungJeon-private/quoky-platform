import { describe, expect, it } from 'vitest';
import type { MessageBody, MessageNode, OutboundMessage } from '../domain';
import { ResponseComposer } from './response-composer';
import { PLT1_VARIANTS, plt1Replies } from './plt1-corpus';
import type { Plt1Variant } from './plt1-corpus';
import { plainTextOf } from './message-rendering';

/**
 * PLT-1: the Core replies that name an outside value (a path, branch, repository, commit message, URL) write it as an
 * untrusted span, never as a plain string node. A platform adapter then neutralizes it its own way; the plain text of
 * every reply (`OutboundMessage.text`, the conversation history) is exactly what it was.
 */


const composer = new ResponseComposer();

/** The hostile values of the `nasty` variant: none may appear inside a plain string node of any reply. */
const HOSTILE = ['_draft_', '_x_', '*y*', '@everyone', '<@123>', '[a](https://x.example)', '_wip_', '*star*', 'my_org', '*repo*', '*bold*', '`c`'];

/** The string nodes of a body, wherever the layout nodes nest them. */
function stringNodes(nodes: readonly MessageNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly MessageNode[]): void => {
    for (const node of list) {
      if (typeof node === 'string') out.push(node);
      else if (node.kind === 'clip') {
        walk(node.content);
        if (node.after) walk(node.after);
      } else if (node.kind === 'fit-lines') node.lines.forEach((line) => walk(line.content));
      else if (node.kind === 'take-lines') [...node.head, ...node.tail, ...node.lines.map((line) => line.content)].forEach(walk);
      else if (node.kind === 'first-fit') node.candidates.forEach(walk);
    }
  };
  walk(nodes);
  return out;
}

/** Quoky copy outside fenced blocks and inline code spans (both are verbatim on every platform). */
function copyOutsideCode(text: string): string {
  return text.replace(/(`{3,})[\s\S]*?\1/g, '').replace(/`[^`\n]*`/g, '');
}

function bodyOf(reply: OutboundMessage | MessageBody): MessageBody {
  return typeof reply === 'string' || Array.isArray(reply) ? (reply as MessageBody) : ((reply as OutboundMessage).content ?? (reply as OutboundMessage).text);
}

describe('PLT-1: outside values in Core replies are untrusted spans', () => {
  const nasty = PLT1_VARIANTS.find((variant) => variant.id === 'nasty') as Plt1Variant;

  it('covers every converted reply', () => {
    expect(plt1Replies(composer, nasty).length).toBeGreaterThanOrEqual(50);
  });

  for (const variant of PLT1_VARIANTS) {
    it(`${variant.id}: content and text agree, and every reply carries untrusted spans`, () => {
      for (const [id, reply] of plt1Replies(composer, variant)) {
        const body = bodyOf(reply);
        expect(Array.isArray(body), `${id} carries spans`).toBe(true);
        if (typeof reply !== 'string' && !Array.isArray(reply)) expect(plainTextOf(body), id).toBe((reply as OutboundMessage).text);
      }
    });
  }

  it('no hostile value is written into a plain string node (fenced blocks and inline code excepted)', () => {
    const hits: string[] = [];
    for (const [id, reply] of plt1Replies(composer, nasty)) {
      const body = bodyOf(reply);
      if (typeof body === 'string') {
        hits.push(`${id}: plain string reply`);
        continue;
      }
      for (const node of stringNodes(body)) {
        const copy = copyOutsideCode(node);
        for (const value of HOSTILE) if (copy.includes(value)) hits.push(`${id}: ${value} in ${JSON.stringify(copy.slice(0, 80))}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the plain text keeps every value exactly as given', () => {
    const [p1, p2] = nasty.paths;
    const applied = composer.composeWorkspaceApplied({ platform: 'discord', channelId: 'c', userId: 'u' }, [p1, p2], [p2]);
    expect(applied.text).toContain(`파일을 수정했어요: ${p1}, ${p2} (새 파일)`);
    const commit = composer.composeCommitApprovalRequested({ platform: 'discord', channelId: 'c', userId: 'u' }, { candidateFiles: [p1], commitMessage: nasty.message, validation: 'none' });
    expect(commit.text).toContain(`커밋 메시지: ${nasty.message}`);
  });
});
