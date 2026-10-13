import { isIP } from 'node:net';

/**
 * Deny ranges for the egress guard's connection-bound address check (ADR-0121 D8, design §5.2 step 1, threat T13).
 *
 * A host name on the allowlist is not enough: it can resolve, or be rebound, to an internal or metadata address. The
 * guard therefore classifies EVERY resolved address with {@link classifyAddress} and refuses (in `enforce`) when any of
 * them falls in one of these ranges: for IPv4 every non-globally-reachable entry of the IANA special-purpose registry,
 * for IPv6 likewise (see `classifyIpv6`). IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:a.b.c.d`, the
 * deprecated IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`) are classified by the embedded IPv4
 * address, so `::ffff:10.0.0.1` or `::ffff:a9fe:a9fe` cannot slip past an IPv4 rule; the mapped, compatible and 6to4
 * forms are refused even with a public embedded address (they are not globally reachable as IPv6).
 *
 * Pure functions, no I/O. Input is an address string as a resolver or a socket reports it (zone ids are ignored);
 * anything that is not an IP address is `invalid`, which the guard treats like a deny range.
 */

/** Why an address is refused. `undefined` from {@link classifyAddress} means a public unicast address. */
export type DenyCategory =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'cgnat'
  | 'ula'
  | 'multicast'
  | 'documentation'
  | 'benchmark'
  | 'reserved'
  | 'invalid';

interface Ipv4Rule {
  readonly base: number;
  readonly bits: number;
  readonly category: DenyCategory;
}

/** Ordered most specific first (the metadata /32 before link-local /16). */
const IPV4_RULES: readonly Ipv4Rule[] = [
  rule4('169.254.169.254', 32, 'metadata'),
  rule4('0.0.0.0', 8, 'unspecified'),
  rule4('10.0.0.0', 8, 'private'),
  rule4('100.64.0.0', 10, 'cgnat'),
  rule4('127.0.0.0', 8, 'loopback'),
  rule4('169.254.0.0', 16, 'link-local'),
  rule4('172.16.0.0', 12, 'private'),
  rule4('192.0.0.0', 24, 'reserved'),
  rule4('192.0.2.0', 24, 'documentation'),
  rule4('192.88.99.0', 24, 'reserved'),
  rule4('192.168.0.0', 16, 'private'),
  rule4('198.18.0.0', 15, 'benchmark'),
  rule4('198.51.100.0', 24, 'documentation'),
  rule4('203.0.113.0', 24, 'documentation'),
  rule4('224.0.0.0', 4, 'multicast'),
  rule4('240.0.0.0', 4, 'reserved'),
];

function rule4(address: string, bits: number, category: DenyCategory): Ipv4Rule {
  const base = parseIpv4(address);
  if (base === undefined) throw new Error('invalid built-in IPv4 rule');
  return { base, bits, category };
}

/** Dotted-quad decimal only (what resolvers and the WHATWG URL parser produce). */
export function parseIpv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(value: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

function classifyIpv4(value: number): DenyCategory | undefined {
  for (const entry of IPV4_RULES) {
    if (inIpv4Range(value, entry.base, entry.bits)) return entry.category;
  }
  return undefined;
}

/** Parses an IPv6 address (with `::`, an embedded dotted IPv4 tail and an optional `%zone`) into 8 groups. */
export function parseIpv6(text: string): number[] | undefined {
  const zone = text.indexOf('%');
  const address = (zone >= 0 ? text.slice(0, zone) : text).toLowerCase();
  if (address === '' || !/^[0-9a-f:.]+$/.test(address)) return undefined;
  let tail: number[] = [];
  let head = address;
  const lastColon = address.lastIndexOf(':');
  if (address.includes('.')) {
    const v4 = parseIpv4(address.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    head = `${address.slice(0, lastColon + 1)}`;
    // `::1.2.3.4` leaves `::`; `::ffff:1.2.3.4` leaves `::ffff:`; drop one trailing ':' unless it is part of '::'.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const doubleColon = head.indexOf('::');
  if (doubleColon !== head.lastIndexOf('::')) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  let groups: number[];
  if (doubleColon >= 0) {
    const left = parse(head.slice(0, doubleColon));
    const right = parse(head.slice(doubleColon + 2));
    if (left === undefined || right === undefined) return undefined;
    const missing = 8 - left.length - right.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right, ...tail];
  } else {
    const all = parse(head);
    if (all === undefined) return undefined;
    groups = [...all, ...tail];
  }
  return groups.length === 8 ? groups : undefined;
}

function embeddedIpv4(groups: readonly number[], index: number): number {
  return (groups[index] ?? 0) * 65536 + (groups[index + 1] ?? 0);
}

function startsWith(groups: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => groups[index] === value);
}

/** Matches the first `bits` bits of `groups` against `prefix` (groups beyond the prefix are ignored). */
function inIpv6Range(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i += 1) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

/**
 * IPv6: every entry of the IANA IPv6 Special-Purpose Address Registry that is not marked "Globally Reachable: True",
 * plus multicast and the deprecated site-local block, plus anything outside global unicast 2000::/3. Where the registry
 * marks only a few anycast sub-blocks of 2001::/23 as globally reachable (PCP, TURN, DNS-SD, AMT, AS112, ORCHIDv2, drone
 * remote ID), the whole /23 is still refused: Quoky never connects to them, so stricter costs nothing.
 */
function classifyIpv6(groups: readonly number[]): DenyCategory | undefined {
  const zeroUpTo = (n: number): boolean => groups.slice(0, n).every((g) => g === 0);
  if (zeroUpTo(8)) return 'unspecified'; // ::/128
  if (zeroUpTo(7) && groups[7] === 1) return 'loopback'; // ::1/128
  // IPv4-mapped ::ffff:0:0/96 (registry: not globally reachable) and the deprecated IPv4-compatible ::/96: the embedded
  // IPv4 names the category; a public embedded address is still refused as `reserved`.
  if (zeroUpTo(5) && groups[5] === 0xffff) return classifyIpv4(embeddedIpv4(groups, 6)) ?? 'reserved';
  if (zeroUpTo(6)) return classifyIpv4(embeddedIpv4(groups, 6)) ?? 'reserved';
  // NAT64 well-known prefix 64:ff9b::/96 is globally reachable: the embedded IPv4 decides. Local-use 64:ff9b:1::/48 is not.
  if (startsWith(groups, [0x64, 0xff9b, 0, 0, 0, 0])) return classifyIpv4(embeddedIpv4(groups, 6));
  if (inIpv6Range(groups, [0x64, 0xff9b, 1], 48)) return 'reserved';
  if (inIpv6Range(groups, [0x0100, 0, 0, 0], 64)) return 'reserved'; // discard-only 100::/64
  if (inIpv6Range(groups, [0x0100, 0, 0, 1], 64)) return 'reserved'; // dummy IPv6 prefix 100:0:0:1::/64
  if (inIpv6Range(groups, [0x2001, 0x0db8], 32)) return 'documentation'; // 2001:db8::/32
  if (inIpv6Range(groups, [0x2001, 0x0002, 0], 48)) return 'benchmark'; // 2001:2::/48
  if (inIpv6Range(groups, [0x2001], 23)) return 'reserved'; // IETF protocol assignments incl. Teredo 2001::/32, ORCHID
  // 6to4 2002::/16 (registry: N/A): the embedded IPv4 in bits 16-47 names the category, otherwise `reserved`.
  if (groups[0] === 0x2002) return classifyIpv4(embeddedIpv4(groups, 1)) ?? 'reserved';
  if (inIpv6Range(groups, [0x3fff], 20)) return 'documentation'; // 3fff::/20
  if (inIpv6Range(groups, [0x5f00], 16)) return 'reserved'; // SRv6 SIDs 5f00::/16
  // AWS IMDS over IPv6 (inside the ULA range, named for the log).
  if (startsWith(groups, [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254])) return 'metadata';
  if (inIpv6Range(groups, [0xfc00], 7)) return 'ula'; // fc00::/7
  if (inIpv6Range(groups, [0xfe80], 10)) return 'link-local'; // fe80::/10
  if (inIpv6Range(groups, [0xfec0], 10)) return 'reserved'; // deprecated site-local fec0::/10
  if (inIpv6Range(groups, [0xff00], 8)) return 'multicast'; // ff00::/8
  if (!inIpv6Range(groups, [0x2000], 3)) return 'reserved'; // outside global unicast 2000::/3
  return undefined;
}

/**
 * The deny category of an address, or `undefined` for a public unicast address. Anything that is not an IPv4 or IPv6
 * address is `invalid`.
 */
export function classifyAddress(address: string): DenyCategory | undefined {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(bare.split('%')[0] ?? '');
  if (family === 4) {
    const value = parseIpv4(bare);
    return value === undefined ? 'invalid' : classifyIpv4(value);
  }
  if (family === 6) {
    const groups = parseIpv6(bare);
    return groups === undefined ? 'invalid' : classifyIpv6(groups);
  }
  return 'invalid';
}

/** True when `host` (a URL hostname, brackets allowed) is an IP literal rather than a name. */
export function isIpLiteral(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare.split('%')[0] ?? '') !== 0;
}
