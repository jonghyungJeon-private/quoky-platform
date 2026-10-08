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
 *   (`kim@example.com`) and a file name whose "TLD" is a common file extension (`README.md`, `main.py`), each only
 *   when no path follows.
 * - `body` (the readout body, which only the provider reads, never a chat platform): scheme URLs and `www.` hosts as
 *   above, and a bare domain only when a path, query or fragment follows it or its TLD is a common web TLD. Plain words
 *   such as `Node.js` or `v1.2.3` stay intact in a summary of a technical mail; the reply is neutralized in `display`
 *   mode anyway, so a domain the model echoes is caught there.
 *
 * Not caught (and not clickable either): defanged forms such as `hxxp[:]//evil[.]example`, `evil[.]example`, or a host
 * split by spaces; a full-width scheme in listing fields (the readout applies NFKC first).
 *
 * Linear: every repetition is bounded, and each domain label is matched atomically (a lookahead capture and its
 * back-reference), so a failed match never re-scans a label.
 */

export const LINK_PLACEHOLDER = '[링크]';

export type LinkNeutralizationMode = 'display' | 'body';

/** A scheme URL or a `www.` host: no word boundary is required, so `1https://…` and `_https://…` are caught. */
const SCHEME_OR_WWW = /(?:[a-z][a-z0-9+.-]{0,15}:\/\/|www\.)[^\s<>"'`()[\]]*/giu;

/** IDN top-level domains the bare-domain pattern accepts besides alphabetic and punycode ones. */
const IDN_TLDS = '한국|中国|中國|日本|香港|台灣|рф|рус|онлайн|сайт';

/**
 * A bare domain: up to 10 atomically matched labels, a TLD, then an optional port and path. Group 2 is the TLD,
 * group 3 the port + path part. A match starts only where a label starts (not after a letter, digit or `-`), so a long
 * letter run is scanned once, not once per position; a label may be as long as a whole host name (253).
 */
const BARE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}-])(?:(?=([\\p{L}\\p{N}-]{1,253}))\\1\\.){1,10}([a-z]{2,24}|xn--[a-z0-9-]{1,59}|${IDN_TLDS})(?![\\p{L}\\p{N}-])((?::\\d{1,5})?(?:[/?#][^\\s<>"'\`()[\\]]*)?)`,
  'giu',
);

/** "TLDs" that are really file extensions; a file name is kept in `display` mode unless a path follows. */
const FILE_EXTENSIONS = new Set([
  'md', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'sh', 'go', 'rs', 'java', 'kt', 'cs', 'cpp', 'txt', 'log', 'csv', 'json',
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
    if (mode === 'body') {
      return hasPath || WEB_TLDS.has(tldLower) || tldLower.startsWith('xn--') || /[^a-z]/.test(tldLower)
        ? LINK_PLACEHOLDER
        : match;
    }
    if (!hasPath && text.charAt(offset - 1) === '@') return match; // the domain of an e-mail address
    if (!hasPath && FILE_EXTENSIONS.has(tldLower)) return match; // a file name
    return LINK_PLACEHOLDER;
  });
}

/**
 * Every link in `text` replaced by {@link LINK_PLACEHOLDER} (see the module comment for the two modes). Repeated until
 * stable (at most 3 rounds), so a replacement can never join pieces into a new link.
 */
export function neutralizeLinks(text: string, mode: LinkNeutralizationMode = 'display'): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const next = replaceBareDomains(current.replace(SCHEME_OR_WWW, LINK_PLACEHOLDER), mode);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/** Whether `text` still holds a link `neutralizeLinks` would replace in `mode` (the runtime re-check). */
export function containsLink(text: string, mode: LinkNeutralizationMode = 'display'): boolean {
  return neutralizeLinks(text, mode) !== text;
}
