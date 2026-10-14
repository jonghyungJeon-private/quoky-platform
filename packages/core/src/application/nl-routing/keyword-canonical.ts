/**
 * The selector-side keyword rule of ADR-0120 D4 (a leaf module, no imports, so a Class B grammar can use it without an
 * import cycle through the catalog).
 */

/**
 * Search-term canonicalization (not routing): a trailing generic noun the selector sometimes keeps ("온보딩 문서" →
 * "온보딩", "정책 자료" → "정책") is dropped when words remain. The closed list names kinds of content, never a source or
 * a capability, so it cannot change which entry runs — only the search words.
 */
const GENERIC_TAIL = new Set([
  '문서', '문서들', '자료', '페이지', '파일', '관련', '얘기', '내용', '메시지', '건', '거', '것',
  // Conversational filler after the topic ("배포 얘기 나온 거"): the search term is the topic alone (live UAT R7).
  '나온', '나왔던', '나왔나', '언급된', '언급한', '올라온', '있는', '있던', '관련된', '관한', '대한', '이야기',
]);

function withoutGenericTail(keyword: string): string {
  const words = keyword.split(' ');
  while (words.length > 1 && GENERIC_TAIL.has(words[words.length - 1] as string)) words.pop();
  return words.join(' ');
}

/**
 * The keyword a validated selection would search for (NFC, whitespace collapsed, generic tail dropped). Exported so a
 * Class B grammar can tell whether its free-text slot is already that keyword (ADR-0120 A2, `slotSwallowsClause`).
 */
export function canonicalNlKeyword(value: string): string {
  return withoutGenericTail(value.normalize('NFC').replace(/\s+/g, ' ').trim());
}
