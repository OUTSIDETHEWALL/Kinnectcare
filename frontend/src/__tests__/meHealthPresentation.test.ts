import fs from 'fs';
import path from 'path';
import { computeHealthItems, worstHealthStatus, HealthItem } from '../healthCheck';
import { meHealthItems } from '../meHealthPresentation';
import { e, testNow as now } from './backgroundEvidenceFixture';

describe('Me-tab heartbeat presentation only', () => {
  it.each([4, 20, 120])('keeps a %d-minute heartbeat in Diagnostics but not the Me banner', minutes => {
    const diagnostics = computeHealthItems([e('sdk_onHeartbeat', now - minutes * 60_000)], now);
    const before = JSON.stringify(diagnostics);
    const heartbeat = diagnostics.find(item => item.label.startsWith('Last background heartbeat:'))!;
    expect(heartbeat.status).toBe('warn');
    expect(heartbeat.label).toContain(`${minutes < 60 ? `${minutes}m` : '2h'}`);
    const visible = meHealthItems(diagnostics);
    expect(visible).not.toContain(heartbeat);
    expect(worstHealthStatus(visible)).not.toBe('warn');
    expect(JSON.stringify(diagnostics)).toBe(before);
  });

  it('does not promote missing heartbeat evidence to a warning', () => {
    const diagnostics = computeHealthItems([], now);
    expect(diagnostics.some(item => item.label === 'Background heartbeat: waiting for first event')).toBe(true);
    expect(meHealthItems(diagnostics).some(item => /heartbeat/i.test(item.label))).toBe(false);
  });

  it('preserves every non-heartbeat observation, including legitimate warnings and errors', () => {
    const items: HealthItem[] = [
      { status: 'warn', icon: 'warning', label: 'Last background heartbeat: 4m ago' },
      { status: 'error', icon: 'error', label: 'Background service stopped' },
      { status: 'error', icon: 'error', label: 'Location permission not granted' },
      { status: 'warn', icon: 'warning', label: 'Power Saver is on — may slow updates' },
      { status: 'unknown', icon: 'info', label: 'Location upload: no retained confirmation' },
      { status: 'ok', icon: 'ok', label: 'Battery monitoring active' },
    ];
    const visible = meHealthItems(items);
    expect(visible).toEqual(items.slice(1));
    visible.forEach((item, index) => expect(item).toBe(items[index + 1]));
    expect(worstHealthStatus(visible)).toBe('error');
    expect(worstHealthStatus(meHealthItems([items[0], items[3]]))).toBe('warn');
  });

  it('wires the presentation filter only to the Me banner and preserves Diagnostics navigation', () => {
    const me = fs.readFileSync(path.join(__dirname, '../../app/(tabs)/me.tsx'), 'utf8');
    expect(me).toContain('<HealthIndicator items={meHealthItems(healthItems)} onPress={onOpenDiagnostics} />');
    expect(me).toContain('setHealthItems(computeHealthItems(log, Date.now(), lastHttpSuccessMs))');
    expect(me).toContain("router.push('/diagnostics' as any)");
    expect(me).toContain('testID="me-app-version-tap"');
    expect(me).toContain('testID="me-diagnostics"');
    expect(me).toContain('onPress={onOpenDiagnostics}');
    expect(me).toContain('setInterval(refresh, 60_000)');
  });
});
