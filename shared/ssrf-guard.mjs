// Blocks requests to private / loopback / link-local / reserved address space.
// Used by the hosted API so it can't be turned into an SSRF proxy into the host's network.
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6');

/** True when the IP literal is in a non-public range. Handles IPv4-mapped IPv6 (::ffff:a.b.c.d). */
export function isPrivateAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP: treat as unsafe
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}
