import { describe, expect, it } from 'vitest';
import { classifyAddress, isIpLiteral, parseIpv6 } from './ip-ranges';

describe('deny ranges (ADR-0121 D8, design §5.2 step 1, T13)', () => {
  it.each([
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.10', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.10.0.1', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.251', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'benchmark'],
    ['192.0.2.1', 'documentation'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::1', 'ula'],
    ['fd12:3456:789a::1', 'ula'],
    ['fd00:ec2::254', 'metadata'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['[::1]', 'loopback'],
  ])('%s is %s', (address, category) => {
    expect(classifyAddress(address)).toBe(category);
  });

  it.each([
    // IPv4-mapped IPv6, dotted and hex forms, of every IPv4 deny range.
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:100.64.0.1', 'cgnat'],
    ['::FFFF:192.168.0.1', 'private'],
    ['0:0:0:0:0:ffff:172.16.0.1', 'private'],
    // Deprecated IPv4-compatible, NAT64 and 6to4 forms carry the embedded IPv4.
    ['::10.0.0.1', 'private'],
    ['::8.8.8.8', 'reserved'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['2002:a00:1::1', 'private'],
    ['2002:c0a8:101::', 'private'],
  ])('embedded IPv4 %s is %s', (address, category) => {
    expect(classifyAddress(address)).toBe(category);
  });

  it.each([
    // IANA IPv6 Special-Purpose Address Registry: every entry not marked "Globally Reachable: True".
    ['::1', 'loopback'], // ::1/128 loopback
    ['::', 'unspecified'], // ::/128 unspecified
    ['::ffff:8.8.8.8', 'reserved'], // ::ffff:0:0/96 IPv4-mapped (public embedded address still refused)
    ['64:ff9b:1::1', 'reserved'], // 64:ff9b:1::/48 local-use IPv4/IPv6 translation
    ['100::1', 'reserved'], // 100::/64 discard-only
    ['100:0:0:1::1', 'reserved'], // 100:0:0:1::/64 dummy IPv6 prefix
    ['2001::1', 'reserved'], // 2001::/23 IETF protocol assignments; 2001::/32 Teredo (N/A)
    ['2001:1::1', 'reserved'], // 2001:1::1/128 PCP anycast (globally reachable, still refused: inside 2001::/23)
    ['2001:2::1', 'benchmark'], // 2001:2::/48 benchmarking
    ['2001:10::1', 'reserved'], // 2001:10::/28 deprecated ORCHID (N/A)
    ['2001:20::1', 'reserved'], // 2001:20::/28 ORCHIDv2 (refused with the /23)
    ['2001:db8:1::1', 'documentation'], // 2001:db8::/32 documentation
    ['2002:808:808::1', 'reserved'], // 2002::/16 6to4 (N/A), public embedded address
    ['3fff::1', 'documentation'], // 3fff::/20 documentation
    ['3fff:fff::1', 'documentation'],
    ['5f00::1', 'reserved'], // 5f00::/16 SRv6 SIDs
    ['fc00::1', 'ula'], // fc00::/7 unique-local
    ['fe80::abcd', 'link-local'], // fe80::/10 link-local unicast
    ['fec0::1', 'reserved'], // deprecated site-local
    ['ff0e::1', 'multicast'],
    ['4000::1', 'reserved'], // outside global unicast 2000::/3
  ])('IPv6 special-purpose %s is %s', (address, category) => {
    expect(classifyAddress(address)).toBe(category);
  });

  it.each(['8.8.8.8', '1.1.1.1', '149.154.167.220', '162.159.135.232', '100.63.255.255', '100.128.0.1', '172.32.0.1',
    '169.253.255.255', '2606:4700::6810:84e5', '2001:4860:4860::8888', '3fff:1000::1', '2001:200::1', '64:ff9b::808:808'])(
    'public %s is allowed',
    (address) => {
      expect(classifyAddress(address)).toBeUndefined();
    },
  );

  it.each(['example.com', '', '1.2.3', '256.1.1.1', '01.2.3.4', '::g', '1::2::3', 'localhost'])('non-address %j is invalid', (address) => {
    expect(classifyAddress(address)).toBe('invalid');
  });

  it('parses compressed and embedded IPv6 forms into 8 groups', () => {
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6('1::8')).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeUndefined();
  });

  it('detects IP literals in URL host form', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('api.telegram.org')).toBe(false);
  });
});
