import { describe, it, expect, vi } from 'vitest';
import { customRestreamUrl, isPublicAddress } from '../../src/lib/restreamUrl.js';

const resolvesTo = (...ips: string[]) => vi.fn(async () => ips);

describe('isPublicAddress', () => {
  it('lets public v4 and v6 through', () => {
    for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip)).toBe(true);
    }
  });

  it('refuses loopback, private, link-local, CGNAT, multicast and mapped private', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('customRestreamUrl', () => {
  it('takes an rtmp or rtmps URL with a key on a public host', async () => {
    const lookup = resolvesTo('104.16.1.1');
    expect(await customRestreamUrl(' rtmp://live.restream.io/live/re_123 ', lookup))
      .toEqual({ url: 'rtmp://live.restream.io/live/re_123' });
    expect(lookup).toHaveBeenCalledWith('live.restream.io');
    expect(await customRestreamUrl('rtmps://live-api-s.facebook.com:443/rtmp/FB-1?s_bl=1&s_ps=1', resolvesTo('157.240.1.1')))
      .toEqual({ url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-1?s_bl=1&s_ps=1' });
  });

  it('refuses other schemes, a missing key, credentials and spaces', async () => {
    const lookup = resolvesTo('104.16.1.1');
    for (const bad of [
      'http://live.restream.io/live/k', 'srt://live.restream.io/live/k', 'rtmp://live.restream.io',
      'rtmp://live.restream.io/', 'rtmp://user:pw@live.restream.io/live/k', 'rtmp://live.restream.io/live/a b',
    ]) {
      expect(await customRestreamUrl(bad, lookup), bad).toHaveProperty('error');
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to an internal address, even one of several', async () => {
    expect(await customRestreamUrl('rtmp://evil.example/live/k', resolvesTo('104.16.1.1', '10.0.0.5')))
      .toEqual({ error: 'That server is not a public address' });
    expect(await customRestreamUrl('rtmp://127.0.0.1:1935/live/k', resolvesTo()))
      .toEqual({ error: 'That server is not a public address' });
    expect(await customRestreamUrl('rtmp://[::1]/live/k', resolvesTo()))
      .toEqual({ error: 'That server is not a public address' });
  });

  it('says so when the host cannot be found', async () => {
    const lookup = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    expect(await customRestreamUrl('rtmp://nope.invalid/live/k', lookup))
      .toEqual({ error: 'That server could not be found' });
  });
});
