import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

// A host's own restream destination (Restream.io, Kick, Facebook, ...): the
// platform's server URL with the stream key on the end, as one rtmp(s) URL.
// LiveKit egress connects to it from inside our network, so it must be on a
// public address: never loopback, a private range or link-local (cloud metadata).

const MAX_LEN = 1000;
const URL_RE = /^rtmps?:\/\/[^\s/?#@]+\/\S+$/i;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
] as const) blocked.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** The egress URL for a custom destination, or `{ error }` with a message for the host. */
export async function customRestreamUrl(
  target: string,
  lookup: Lookup = defaultLookup,
): Promise<{ url: string } | { error: string }> {
  const url = target.trim();
  if (url.length > MAX_LEN || !URL_RE.test(url)) {
    return { error: 'Use the server URL (rtmp:// or rtmps://) and a stream key' };
  }
  const { hostname } = new URL(url.replace(/^rtmps?:/i, 'http:'));
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    return { error: 'That server could not be found' };
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) {
    return { error: 'That server is not a public address' };
  }
  return { url };
}
