import { isIP } from 'node:net';
import dns from 'node:dns';

export class SsrfError extends Error { constructor(message: string) { super(message); this.name = 'SsrfError'; } }

function v4ToInt(ip: string): number { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function inV4Block(ip: string, [base, bits]: [string, number]) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const n = v4ToInt(m[1]!); s = s.replace(m[1]!, `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`); }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : []; const tail = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0; if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for globally routable addresses. Anything unparseable counts as NOT public. */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !V4_BLOCKS.some(b => inV4Block(ip, b));
  if (kind === 6) {
    const g = expandV6(ip); if (!g) return false;
    if (g.every(x => x === 0) || (g.slice(0, 7).every(x => x === 0) && g[7] === 1)) return false;          // :: and ::1
    if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00) return false; // ULA, link-local, multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                                                   // documentation
    if (g[0] === 0x0064 && g[1] === 0xff9b) return false;                                                   // NAT64
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPublicIp(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`); // v4-mapped
    return true;
  }
  return false;
}

export type ResolveHost = (host: string) => Promise<string[]>;
export const systemResolve: ResolveHost = async host => (await dns.promises.lookup(host, { all: true })).map(a => a.address);

/** Pre-flight check run on the initial URL and again on every redirect hop. */
export async function assertPublicUrl(raw: string, resolve: ResolveHost = systemResolve): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new SsrfError('credentials in URL not allowed');
  if (u.port && !['80', '443'].includes(u.port)) throw new SsrfError(`port ${u.port} not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) { if (!isPublicIp(host)) throw new SsrfError('address is not public'); return u; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new SsrfError('internal hostname');
  let addrs: string[];
  try { addrs = await resolve(host); } catch { throw new SsrfError('hostname did not resolve'); }
  if (!addrs.length || !addrs.every(isPublicIp)) throw new SsrfError('hostname resolves to a non-public address');
  return u;
}

/** Used by the production fetch: validates the address at CONNECT time, closing the DNS-rebinding gap
 *  between the pre-flight check and the actual connection. */
export function makeGuardedLookup(lookup: typeof dns.lookup = dns.lookup) {
  return (hostname: string, options: any, cb: (err: Error | null, address?: any, family?: number) => void) => {
    lookup(hostname, { ...options, all: true }, (err: any, addresses: any) => {
      if (err) return cb(err);
      const list: Array<{ address: string; family: number }> = addresses;
      if (!list.length || !list.every(a => isPublicIp(a.address))) return cb(new SsrfError('blocked non-public address at connect time'));
      if (options?.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}
