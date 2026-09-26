import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import {
  distanceMeters,
  isOnNetwork,
  isPrivateAddress,
  parseNetworkEntry,
  suggestNetworkEntry,
  verifyOnsite,
  type OnsitePolicy,
} from '../src/services/onsite';

/**
 * On-site check-in: at a location that requires it, people check in and out
 * with the office QR code, from inside the geofence, on the office network.
 */

const OFFICE = { latitude: 25.204849, longitude: 55.270782 };
// About 50 m north of the office, and about 2.2 km north.
const NEARBY = { latitude: OFFICE.latitude + 0.00045, longitude: OFFICE.longitude };
const FAR_AWAY = { latitude: OFFICE.latitude + 0.02, longitude: OFFICE.longitude };
const OFFICE_IP = '203.0.113.7';
const HOME_IP = '198.51.100.23';
const CODE = 'scan-me-2026';

describe('on-site check-in', () => {
  describe('the rules', () => {
    const policy: OnsitePolicy = {
      locationId: 'loc',
      locationName: 'Dubai Office',
      qrCode: CODE,
      latitude: OFFICE.latitude,
      longitude: OFFICE.longitude,
      radiusMeters: 200,
      allowedNetworks: ['203.0.113.0/24', '2001:db8:12:34::/64'],
      wifiName: 'Office-5G or Office-2G',
    };

    it('measures distances on the globe', () => {
      expect(Math.round(distanceMeters(OFFICE, NEARBY))).toBe(50);
      expect(Math.round(distanceMeters(OFFICE, FAR_AWAY) / 100) * 100).toBe(2200);
      expect(distanceMeters(OFFICE, OFFICE)).toBe(0);
    });

    it('recognises the office network: IPv4 addresses and ranges, IPv6 /64, IPv4-mapped', () => {
      expect(isOnNetwork(OFFICE_IP, policy.allowedNetworks)).toBe(true);
      expect(isOnNetwork(`::ffff:${OFFICE_IP}`, policy.allowedNetworks)).toBe(true);
      expect(isOnNetwork('2001:db8:12:34:aaaa:bbbb:cccc:1', policy.allowedNetworks)).toBe(true);
      expect(isOnNetwork('2001:db8:12:35::1', policy.allowedNetworks)).toBe(false);
      expect(isOnNetwork(HOME_IP, policy.allowedNetworks)).toBe(false);
      expect(isOnNetwork(null, policy.allowedNetworks)).toBe(false);
      expect(parseNetworkEntry('203.0.113.0/33')).toBeNull();
      expect(parseNetworkEntry('Office-5G')).toBeNull();
    });

    it('suggests what to store for the network a request came from', () => {
      expect(suggestNetworkEntry(`::ffff:${OFFICE_IP}`)).toBe(OFFICE_IP);
      expect(suggestNetworkEntry('2001:db8:12:34:aaaa:bbbb:cccc:1')).toBe('2001:db8:12:34::/64');
      expect(suggestNetworkEntry('2001:db8::1')).toBe('2001:db8:0:0::/64');
    });

    it("treats a proxy's or a LAN's address as private", () => {
      for (const ip of ['10.0.3.4', '172.20.1.1', '192.168.1.20', '127.0.0.1', '::1', 'fd00::1', '100.64.0.9']) {
        expect(isPrivateAddress(ip), ip).toBe(true);
      }
      expect(isPrivateAddress(OFFICE_IP)).toBe(false);
    });

    it('refuses a wrong code, a missing or distant position and another network - in that order', () => {
      expect(verifyOnsite(policy, { qrCode: 'guess', ...NEARBY }, OFFICE_IP)).toMatchObject({ ok: false, reason: 'QR_CODE' });
      expect(verifyOnsite(policy, { qrCode: CODE }, OFFICE_IP)).toMatchObject({ ok: false, reason: 'LOCATION_MISSING' });
      expect(verifyOnsite(policy, { qrCode: CODE, ...FAR_AWAY }, OFFICE_IP)).toMatchObject({ ok: false, reason: 'TOO_FAR' });
      const offNetwork = verifyOnsite(policy, { qrCode: CODE, ...NEARBY }, HOME_IP);
      expect(offNetwork).toMatchObject({ ok: false, reason: 'NETWORK' });
      expect(offNetwork.ok ? '' : offNetwork.message).toContain('Office-5G or Office-2G');

      const accepted = verifyOnsite(policy, { qrCode: ` ${CODE} `, ...NEARBY, accuracy: 18.4 }, OFFICE_IP);
      expect(accepted).toMatchObject({
        ok: true,
        verification: { method: 'QR', locationName: 'Dubai Office', distanceMeters: 50, accuracyMeters: 18, network: 'OFFICE', ip: OFFICE_IP },
      });
    });

    it('checks only the signals a location asks for', () => {
      const networkOnly = { ...policy, latitude: null, longitude: null };
      expect(verifyOnsite(networkOnly, { qrCode: CODE }, OFFICE_IP)).toMatchObject({ ok: true, verification: { distanceMeters: null } });
      const positionOnly = { ...policy, allowedNetworks: [] };
      expect(verifyOnsite(positionOnly, { qrCode: CODE, ...NEARBY }, HOME_IP)).toMatchObject({ ok: true, verification: { network: null } });
    });
  });

  describe('at a location that requires it', () => {
    let fixture: Fixture;
    let adminToken: string;
    let employeeToken: string;
    let colleagueToken: string;
    let locationId: string;

    const from = (ip: string) => (method: 'post' | 'get', url: string, token: string) =>
      request(app)[method](url).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip);

    beforeAll(async () => {
      await resetDatabase();
      fixture = await createFixture();
      adminToken = await login(fixture.emails.admin);
      employeeToken = await login(fixture.emails.employee);
      colleagueToken = await login(fixture.emails.colleague);

      const created = await asUser(adminToken).post('/api/v1/work-locations').send({
        code: 'QR-OFFICE',
        name: 'Dubai Office',
        kind: 'OFFICE',
        timezone: 'Asia/Dubai',
        qrCheckInRequired: true,
        qrCode: CODE,
        ...OFFICE,
        geofenceRadiusMeters: 200,
        allowedNetworks: ['203.0.113.0/24'],
        wifiName: 'Office-5G or Office-2G',
      });
      expect(created.status).toBe(201);
      locationId = created.body.data.id as string;

      const assigned = await asUser(adminToken).patch(`/api/v1/employees/${fixture.employee}`).send({ workLocationId: locationId });
      expect(assigned.status).toBe(200);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('shows the code, the position and the networks to HR only', async () => {
      const asHr = (await asUser(adminToken).get('/api/v1/work-locations')).body.data.find((row: { id: string }) => row.id === locationId);
      expect(asHr).toMatchObject({ qrCheckInRequired: true, qrCode: CODE, ...OFFICE, allowedNetworks: ['203.0.113.0/24'] });

      const asEmployee = (await asUser(employeeToken).get('/api/v1/work-locations')).body.data.find((row: { id: string }) => row.id === locationId);
      expect(asEmployee.qrCheckInRequired).toBe(true);
      expect(asEmployee).not.toHaveProperty('qrCode');
      expect(asEmployee).not.toHaveProperty('allowedNetworks');
      expect(asEmployee).not.toHaveProperty('latitude');
    });

    it('will not require a QR code without a second signal, or without a code', async () => {
      const codeOnly = await asUser(adminToken).patch(`/api/v1/work-locations/${locationId}`).send({ latitude: null, longitude: null, allowedNetworks: [] });
      expect(codeOnly.status).toBe(422);
      expect(codeOnly.body.error.details.qrCheckInRequired[0]).toContain('photographed');

      const noCode = await asUser(adminToken).patch(`/api/v1/work-locations/${locationId}`).send({ qrCode: null });
      expect(noCode.status).toBe(422);

      const halfPosition = await asUser(adminToken).patch(`/api/v1/work-locations/${locationId}`).send({ longitude: null });
      expect(halfPosition.status).toBe(422);

      const badNetwork = await asUser(adminToken).patch(`/api/v1/work-locations/${locationId}`).send({ allowedNetworks: ['Office-5G'] });
      expect(badNetwork.status).toBe(422);
    });

    it('tells HR which network they are on, as the API sees it', async () => {
      const seen = await from(OFFICE_IP)('get', '/api/v1/work-locations/my-network', adminToken);
      expect(seen.status).toBe(200);
      expect(seen.body.data).toEqual({ ip: OFFICE_IP, entry: OFFICE_IP, isPrivate: false });

      const refused = await from(OFFICE_IP)('get', '/api/v1/work-locations/my-network', employeeToken);
      expect(refused.status).toBe(403);
    });

    it('tells the check-in card a QR code is needed, never what it is', async () => {
      const today = await asUser(employeeToken).get('/api/v1/attendance/today');
      expect(today.body.data.onSite).toEqual({
        required: true,
        locationName: 'Dubai Office',
        needsLocation: true,
        needsNetwork: true,
        wifiName: 'Office-5G or Office-2G',
      });
      expect(JSON.stringify(today.body)).not.toContain(CODE);
    });

    it('refuses the plain button, a wrong code, a distant position and another network - and audits each', async () => {
      const button = await from(OFFICE_IP)('post', '/api/v1/attendance/check-in', employeeToken).send({});
      expect(button.status).toBe(403);
      expect(button.body.error.message).toContain('Scan the QR code at Dubai Office');

      const wrongCode = await from(OFFICE_IP)('post', '/api/v1/attendance/check-in', employeeToken).send({ qrCode: 'pollux', ...NEARBY });
      expect(wrongCode.status).toBe(403);

      const farAway = await from(OFFICE_IP)('post', '/api/v1/attendance/check-in', employeeToken).send({ qrCode: CODE, ...FAR_AWAY });
      expect(farAway.status).toBe(403);
      expect(farAway.body.error.message).toMatch(/about 2\.2 km from Dubai Office/);

      const home = await from(HOME_IP)('post', '/api/v1/attendance/check-in', employeeToken).send({ qrCode: CODE, ...NEARBY });
      expect(home.status).toBe(403);
      expect(home.body.error.message).toContain('Office-5G or Office-2G');

      expect(await prisma.attendanceRecord.count({ where: { employeeId: fixture.employee } })).toBe(0);
      const refusals = await prisma.auditLog.findMany({ where: { action: 'REJECT', entityType: 'AttendanceRecord' } });
      expect(refusals).toHaveLength(4);
      expect(refusals.map((entry) => entry.summary).join('\n')).not.toContain(CODE);
    });

    it('checks in with the code, on site, on the office network - and keeps the evidence', async () => {
      const response = await from(OFFICE_IP)('post', '/api/v1/attendance/check-in', employeeToken).send({ qrCode: CODE, ...NEARBY, accuracy: 12, source: 'MOBILE' });
      expect(response.status).toBe(201);
      expect(response.body.data.verification.checkIn).toMatchObject({
        method: 'QR',
        locationName: 'Dubai Office',
        distanceMeters: 50,
        accuracyMeters: 12,
        network: 'OFFICE',
        ip: OFFICE_IP,
      });
    });

    it('checks out the same way', async () => {
      const home = await from(HOME_IP)('post', '/api/v1/attendance/check-out', employeeToken).send({ qrCode: CODE, ...NEARBY });
      expect(home.status).toBe(403);

      const office = await from(OFFICE_IP)('post', '/api/v1/attendance/check-out', employeeToken).send({ qrCode: CODE, ...NEARBY });
      expect(office.status).toBe(200);
      expect(office.body.data.verification.checkOut).toMatchObject({ network: 'OFFICE', distanceMeters: 50 });
    });

    it('leaves everyone elsewhere on the plain button', async () => {
      const today = await asUser(colleagueToken).get('/api/v1/attendance/today');
      expect(today.body.data.onSite).toBeNull();
      const plain = await from(HOME_IP)('post', '/api/v1/attendance/check-in', colleagueToken).send({});
      expect(plain.status).toBe(201);
      expect(plain.body.data.verification).toBeNull();
    });
  });
});
