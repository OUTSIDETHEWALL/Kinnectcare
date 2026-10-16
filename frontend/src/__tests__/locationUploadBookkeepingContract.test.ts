import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function source(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

describe('location upload success bookkeeping coverage', () => {
  it.each([
    ['src/locationRefresh.ts', 0],
    ['src/backgroundLocation.ts', 1],
    ['app/(tabs)/dashboard.tsx', 0],
  ])('%s records every successful direct location PUT', (file, expectedCalls) => {
    const text = source(file);
    const locationPuts = text.match(/await api\.put\(`\/members\/\$\{[^}]+\}\/location`, body\)/g)
      ?? text.match(/await api\.put\(`\/members\/\$\{[^}]+\}\/location`, bgPayload\)/g)
      ?? [];
    const successRecords = text.match(/await recordLocationUploadSuccess\(\)/g) ?? [];

    expect(locationPuts).toHaveLength(expectedCalls);
    expect(successRecords).toHaveLength(expectedCalls);
  });
  it('centralizes guarded timestamped publication instead of duplicating dashboard/refresh writers', () => {
    expect(source('src/foregroundLocationPublication.ts')).toContain('timestamp: new Date(capturedAt).toISOString()');
    expect(source('src/foregroundLocationPublication.ts')).toContain('requestFreshLocation');
    expect(source('src/locationRefresh.ts')).toContain('return refreshForegroundLocation(reason)');
    expect(source('src/backgroundLocation.ts')).toContain('new Date(fresh.timestamp).toISOString()');
  });

  it('uses the shared recorder for both native success callbacks', () => {
    const text = source('src/locationEngine.ts');

    expect(text.match(/recordLocationUploadSuccess\(\)/g)).toHaveLength(2);
    expect(text).not.toMatch(
      /status === 200 \|\| evt\?\.status === 201[^}]+recordLocationUploadSuccess/s,
    );
  });
});