import crypto from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * On-site check-in: is this person at the office they are assigned to?
 *
 * A location can require three signals, each optional:
 *   - the QR code printed at the office (a shared secret HR can change);
 *   - the position the browser reports, within a radius of the office;
 *   - the public IP address the request arrives from - the office internet
 *     connection that every device on the office Wi-Fi goes out through.
 *
 * A web page cannot read the name of the Wi-Fi network (browsers keep it
 * private), so the network is recognised by the address it reaches the
 * internet from. A QR code can be photographed and a position faked with
 * developer tools, but the office network cannot be joined from home -
 * together they make a check-in from the sofa hard, and every accepted one
 * keeps its evidence.
 */

export interface OnsitePolicy {
  locationId: string;
  locationName: string;
  qrCode: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
  allowedNetworks: string[];
  wifiName: string | null;
}

export interface OnsiteEvidence {
  qrCode?: string;
  latitude?: number;
  longitude?: number;
  /** Radius of uncertainty the browser reports, in metres. */
  accuracy?: number;
}

/** What is stored with an accepted check-in or check-out. */
export interface OnsiteVerification {
  method: 'QR';
  locationId: string;
  locationName: string;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  latitude: number | null;
  longitude: number | null;
  /** 'OFFICE' when the office network was required and matched. */
  network: 'OFFICE' | null;
  ip: string | null;
}

export type OnsiteRefusalReason = 'QR_CODE' | 'LOCATION_MISSING' | 'TOO_FAR' | 'NETWORK';

export type OnsiteResult =
  | { ok: true; verification: OnsiteVerification }
  | { ok: false; reason: OnsiteRefusalReason; message: string; distanceMeters?: number };

const EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance between two points, in metres. */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "::ffff:203.0.113.7" -> "203.0.113.7"; brackets and an IPv6 zone removed. Null if not an IP. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1] as string;
  return isIP(ip) ? ip.toLowerCase() : null;
}

export interface NetworkEntry {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** "203.0.113.7", "203.0.113.0/24" or "2001:db8:1:2::/64"; null if it is none of these. */
export function parseNetworkEntry(entry: string): NetworkEntry | null {
  const parts = entry.trim().split('/');
  if (parts.length > 2) return null;
  const [rawAddress = '', rawPrefix] = parts;
  const address = normalizeIp(rawAddress);
  if (!address) return null;
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
  if (prefix > max) return null;
  return { address, prefix, family };
}

/** Whether an address falls inside any of the entries. */
export function isOnNetwork(ip: string | null | undefined, entries: string[]): boolean {
  const address = normalizeIp(ip);
  if (!address) return false;
  const list = new BlockList();
  for (const entry of entries) {
    const parsed = parseNetworkEntry(entry);
    if (parsed) list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Addresses that only exist inside a network. If the server sees one of these
 * as a visitor's address, it is reading its own proxy rather than the visitor,
 * and an office network made of it would let everyone in.
 */
const PRIVATE_RANGES: NetworkEntry[] = [
  { address: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { address: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { address: '::', prefix: 127, family: 'ipv6' },
  { address: 'fc00::', prefix: 7, family: 'ipv6' },
  { address: 'fe80::', prefix: 10, family: 'ipv6' },
];

export function isPrivateAddress(ip: string | null | undefined): boolean {
  const address = normalizeIp(ip);
  if (!address) return false;
  const list = new BlockList();
  for (const range of PRIVATE_RANGES) list.addSubnet(range.address, range.prefix, range.family);
  return list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

/** The first four groups of an IPv6 address: its /64 network. */
function ipv6Network64(address: string): string {
  const [head = '', tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups];
  return groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':');
}

/**
 * The entry to store for the network a request came from. An IPv4 address is
 * the office router's own; an IPv6 address belongs to one device, so its /64 -
 * the office LAN, where every device picks its own address - is stored.
 */
export function suggestNetworkEntry(ip: string | null | undefined): string | null {
  const address = normalizeIp(ip);
  if (!address) return null;
  return isIP(address) === 4 ? address : `${ipv6Network64(address)}::/64`;
}

/** Compares secrets in constant time, so a wrong guess takes as long as a near miss. */
function sameSecret(expected: string, given: string): boolean {
  const a = crypto.createHash('sha256').update(expected.trim()).digest();
  const b = crypto.createHash('sha256').update(given.trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

const round = (value: number, places: number) => Number(value.toFixed(places));

/** Decides whether an attempt is on site. Pure: no database, no clock. */
export function verifyOnsite(policy: OnsitePolicy, evidence: OnsiteEvidence, ip: string | null | undefined): OnsiteResult {
  if (!policy.qrCode || !evidence.qrCode || !sameSecret(policy.qrCode, evidence.qrCode)) {
    return {
      ok: false,
      reason: 'QR_CODE',
      message: `Scan the QR code at ${policy.locationName} to check in or out.`,
    };
  }

  let distance: number | null = null;
  if (policy.latitude !== null && policy.longitude !== null) {
    if (evidence.latitude === undefined || evidence.longitude === undefined) {
      return {
        ok: false,
        reason: 'LOCATION_MISSING',
        message: 'Your location is needed to check in here. Allow location access for this site, then try again.',
      };
    }
    distance = Math.round(
      distanceMeters({ latitude: policy.latitude, longitude: policy.longitude }, { latitude: evidence.latitude, longitude: evidence.longitude }),
    );
    if (distance > policy.radiusMeters) {
      return {
        ok: false,
        reason: 'TOO_FAR',
        distanceMeters: distance,
        message: `You are about ${formatDistance(distance)} from ${policy.locationName}. Check in from the office - within ${policy.radiusMeters} m.`,
      };
    }
  }

  const address = normalizeIp(ip);
  let network: OnsiteVerification['network'] = null;
  if (policy.allowedNetworks.length > 0) {
    if (!isOnNetwork(address, policy.allowedNetworks)) {
      const wifi = policy.wifiName ? ` (${policy.wifiName})` : '';
      return {
        ok: false,
        reason: 'NETWORK',
        message: `Connect to the ${policy.locationName} Wi-Fi${wifi} to check in. This connection is not the office network.`,
      };
    }
    network = 'OFFICE';
  }

  return {
    ok: true,
    verification: {
      method: 'QR',
      locationId: policy.locationId,
      locationName: policy.locationName,
      distanceMeters: distance,
      accuracyMeters: evidence.accuracy === undefined ? null : Math.round(evidence.accuracy),
      latitude: evidence.latitude === undefined ? null : round(evidence.latitude, 6),
      longitude: evidence.longitude === undefined ? null : round(evidence.longitude, 6),
      network,
      ip: address,
    },
  };
}
