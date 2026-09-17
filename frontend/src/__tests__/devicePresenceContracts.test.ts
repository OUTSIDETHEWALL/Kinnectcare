import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const source = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('device presence telemetry contracts', () => {
  it('labels each existing telemetry transport without adding a new transport', () => {
    const engine = source('src/locationEngine.ts');
    expect(engine).toContain("'X-Kinnship-Presence-Source': 'location-upload'");
    expect(engine).toContain("'X-Kinnship-Presence-Source': 'battery-task'");
    expect(engine).toContain("'X-Kinnship-Presence-Source': 'battery-event'");
    expect(engine).toContain("pushDeviceSnapshotToBackend(pts, now, sdkSt, 'sdk-heartbeat')");
    expect(engine).toContain("presenceSource: 'device-snapshot' | 'sdk-heartbeat'");
    expect(source('src/batteryTask.ts')).toContain("'X-Kinnship-Presence-Source': 'battery-task'");
  });

  it('uses presence selection only for caregiver contact labels and leaves GPS freshness logic on last_seen', () => {
    const dashboard = source('app/(tabs)/dashboard.tsx');
    const memberDetail = source('app/member/[id].tsx');
    const familyCardStatus = source('src/familyCardStatus.ts');

    expect(dashboard).toContain('getFamilyCardStatus(member, issues)');
    expect(familyCardStatus).toContain('selectPresenceTimestamp');
    expect(familyCardStatus).toContain("'Last update' : 'Last contact'");
    expect(familyCardStatus).toContain('const lastSeen = usableTimestamp(member.last_seen, nowMs)');
    expect(familyCardStatus).toContain('last_seen: lastSeen');
    expect(familyCardStatus).toContain("'Location' : 'Last known location'");
    expect(memberDetail).toContain('selectPresenceTimestamp');
    expect(memberDetail).toMatch(/Updated \{formatLastSeenAge\(presenceTimestamp\)\}/);
    expect(dashboard).toContain('const seenMs = member.last_seen ? new Date(member.last_seen).getTime() : 0;');
    expect(dashboard).toContain('requestMemberRefresh(mb.id, seenMs || null);');
    expect(memberDetail).toContain('const seenMs = md.last_seen ? new Date(md.last_seen).getTime() : 0;');
    expect(memberDetail).toContain('requestMemberRefresh(md.id, seenMs || null);');
  });
});