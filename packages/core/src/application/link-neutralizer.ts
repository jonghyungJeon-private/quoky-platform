/**
 * The one link neutralizer for untrusted personal-item text (ADR-0118 D7/D8, GML-1 review P2-4 and its re-review). A
 * hostile mail's links must never reach a provider, never be clickable or embedded in a bot reply, and never make a
 * platform's crawler fetch an attacker URL. Every route uses this function: the summary readout (body, title,
 * author), the runtime's re-check of the readout, the summary reply, and the listing fields (sender, subject,
 * snippet, the echoed sender query).
 *
 * Two modes:
 *
 * - `display` (reply, listing fields, readout title and author): every scheme URL (`https://`, `HTTPS://`, `hxxp://`,
 *   any `scheme://`, also glued to a preceding letter, digit or `_`), every `www.` host, and every bare domain — labels
 *   of letters, digits and `-` (Unicode letters included, so IDN hosts count) ending in an alphabetic TLD of 2–24
 *   letters, a punycode TLD (`xn--…`) or a common IDN TLD — with its port, path, query and fragment. Two exceptions
 *   keep ordinary text readable, and neither is ever autolinked as a web link: the domain of an e-mail address
 *   (`kim@example.com`) and a file name whose "TLD" is a file extension that is NOT a delegated TLD (`report.pdf`,
 *   `index.ts`, `app.js`), each only when no path follows. An extension that is also a country TLD (`.md`, `.sh`,
 *   `.rs`, `.py`) is a link: `README.md` becomes `[링크]`, by design (sign-off item 1).
 * - `body` (the readout body, which only the provider reads, never a chat platform): scheme URLs and `www.` hosts as
 *   above, and a bare domain when a path, query or fragment follows it, its TLD is a common web TLD, a two-letter
 *   country TLD, punycode or IDN. Plain words such as `Node.js` or `v1.2.3` stay intact in a summary of a technical
 *   mail; the reply is neutralized in `display` mode anyway, so a domain the model echoes is caught there.
 *
 * Not caught: defanged forms such as `hxxp[:]//evil[.]example`, `evil[.]example`, or a host split by spaces (not
 * clickable either); a Hangul particle glued to a Hangul IDN TLD (`예시.한국에서`, the IDN branch keeps its Unicode
 * lookahead); IDN TLDs outside {@link IDN_TLDS} in their Unicode form (Arabic-script, most Indic and brand IDN TLDs;
 * their punycode form is caught). Caught since the sign-off: full-width schemes and letters (NFKC), zero-width and
 * other format characters inside a host, combining marks (`café.com`), and ideographic full stops (`evil。com`).
 *
 * Linear: every repetition is bounded, and each domain label is matched atomically (a lookahead capture and its
 * back-reference), so a failed match never re-scans a label.
 */

export const LINK_PLACEHOLDER = '[링크]';

export type LinkNeutralizationMode = 'display' | 'body';

/** A scheme URL or a `www.` host: no word boundary is required, so `1https://…` and `_https://…` are caught. */
const SCHEME_OR_WWW = /(?:[a-z][a-z0-9+.-]{0,15}:\/\/|www\.)[^\s<>"'`()[\]]*/giu;

/**
 * IDN top-level domains the bare-domain pattern accepts besides alphabetic and punycode ones (sign-off item 4): the
 * Hangul, Chinese, Japanese, Cyrillic, Greek, Thai and Devanagari ones in common use. Arabic-script, other Indic and
 * the remaining brand IDN TLDs are not listed (see the not-caught note); their punycode form (`xn--…`) is caught.
 */
const IDN_TLDS = [
  '한국', '닷컴', '닷넷', '삼성',
  '中国', '中國', '香港', '台灣', '台湾', '澳門', '澳门', '新加坡', '公司', '网络', '網絡', '中文网', '在线', '网址',
  '网店', '移动', '商城', '商店', '购物', '游戏', '商标', '手机', '集团', '我爱你', '信息', '机构', '政务', '公益', '时尚',
  '健康', '企业', '广东',
  '日本', 'コム', 'みんな', 'ストア', 'セール', 'ファッション', 'ポイント', 'クラウド',
  'рф', 'рус', 'ком', 'орг', 'онлайн', 'сайт', 'бел', 'укр', 'срб', 'мкд', 'қаз', 'мон', 'бг', 'дети', 'москва',
  'ελ', 'ευ', 'ไทย', 'भारत',
].join('|');
/** Label separators: the ASCII full stop and the ideographic / full-width / half-width full stops (`evil。com`). */
const DOT = '[.\\u3002\\uFF0E\\uFF61]';
/** Format characters (zero-width spaces and joiners, bidi controls, soft hyphen) removed before matching. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * A bare domain: up to 10 atomically matched labels, a TLD, then an optional port and path. Group 2 is the TLD, group
 * 3 the port + path part. After an ASCII TLD only an ASCII letter, digit or `-` continues it, so a Korean particle
 * glued to the domain (`evil.com에서`, `naver.com은`) does not hide it (sign-off item 2); only the IDN and punycode
 * branch treats any following letter as part of the TLD. A match starts only where a label starts (not after a
 * letter, digit or `-`), so a long letter run is scanned once, not once per position; a label may be as long as a
 * whole host name (253).
 */
const BARE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}-])(?:(?=([\\p{L}\\p{M}\\p{N}-]{1,253}))\\1${DOT}){1,10}([a-z]{2,24}(?![a-z0-9-])|(?:xn--[a-z0-9-]{1,59}|${IDN_TLDS})(?![\\p{L}\\p{M}\\p{N}-]))((?::\\d{1,5})?(?:[/?#][^\\s<>"'\`()[\\]]*)?)`,
  'giu',
);

/**
 * File extensions that are NOT delegated top-level domains (checked against the IANA root zone list; `md`, `sh`,
 * `rs`, `py` and `java` are delegated and therefore absent). A file name ending in one of these is kept unless a path
 * follows; in `body` mode a two-letter one is not treated as a country TLD.
 */
const FILE_EXTENSIONS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'rb', 'go', 'kt', 'cs', 'cpp', 'txt', 'log', 'csv', 'json',
  'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'png',
  'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'mp4', 'wav', 'tar', 'gz', 'tgz', 'dmg', 'exe', 'msi', 'apk', 'ipa',
]);

/** Web TLDs that `body` mode replaces even without a path (the common gTLDs and the ccTLDs seen in phishing). */
const WEB_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'ai', 'app', 'dev', 'xyz', 'me', 'ly', 'to', 'cc', 'tv', 'us', 'uk',
  'kr', 'jp', 'cn', 'de', 'fr', 'ru', 'su', 'eu', 'ca', 'au', 'in', 'br', 'top', 'site', 'online', 'shop', 'store',
  'live', 'click', 'link', 'icu', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ws', 'vip', 'club', 'work', 'page', 'help',
  'support', 'email', 'mobi', 'zip', 'mov', 'cloud', 'tech', 'website', 'space', 'fun', 'buzz', 'rest', 'bar',
]);

function replaceBareDomains(text: string, mode: LinkNeutralizationMode): string {
  return text.replace(BARE_DOMAIN, (match: string, _label: string, tld: string, tail: string, offset: number) => {
    const tldLower = tld.toLowerCase();
    const hasPath = tail.length > 0;
    // Final sign-off W-2: an IDN TLD counts only after an ASCII full stop. Many IDN TLDs are everyday CJK words
    // (ポイント, みんな, 手机, 信息), so after an ideographic full stop they are ordinary sentences, not hosts.
    const tldStart = match.length - tail.length - tld.length;
    if (/[^\x00-\x7f]/.test(tld) && match.charAt(tldStart - 1) !== '.') return match;
    if (mode === 'body') {
      const countryTld = tldLower.length === 2 && !FILE_EXTENSIONS.has(tldLower);
      return hasPath || WEB_TLDS.has(tldLower) || countryTld || tldLower.startsWith('xn--') || /[^a-z]/.test(tldLower)
        ? LINK_PLACEHOLDER
        : match;
    }
    if (!hasPath && text.charAt(offset - 1) === '@') return match; // the domain of an e-mail address
    if (!hasPath && FILE_EXTENSIONS.has(tldLower)) return match; // a file name
    return LINK_PLACEHOLDER;
  });
}

/**
 * Every link in `text` replaced by {@link LINK_PLACEHOLDER} (see the module comment for the two modes), on the text with
 * its format characters removed and NFKC applied. Repeated until stable (at most 3 rounds), so a replacement can never
 * join pieces into a new link.
 */
export function neutralizeLinks(text: string, mode: LinkNeutralizationMode = 'display'): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  // Sign-off item 4: invisible format characters removed and NFKC applied first, so `evil\u200b.com` and a
  // decomposed `café.com` are caught (the output is the normalized text).
  let current = text.replace(FORMAT_CHARACTERS, '').normalize('NFKC');
  for (let round = 0; round < 3; round += 1) {
    const next = replaceBareDomains(current.replace(SCHEME_OR_WWW, LINK_PLACEHOLDER), mode);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/** Whether `text` still holds a link `neutralizeLinks` would replace in `mode` (the runtime re-check). */
export function containsLink(text: string, mode: LinkNeutralizationMode = 'display'): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return neutralizeLinks(text, mode) !== text.replace(FORMAT_CHARACTERS, '').normalize('NFKC');
}
