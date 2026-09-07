import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function source(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

describe('location upload success bookkeeping coverage', () => {
  it.each([
    ['src/locationRefresh.ts', 1],
    ['src/backgroundLocation.ts', 1],
    ['app/(tabs)/dashboard.tsx', 2],
  ])('%s records every successful direct location PUT', (file, expectedCalls) => {
    const text = source(file);
    const locationPuts = text.match(/await api\.put\(`\/members\/\$\{[^}]+\}\/location`, body\)/g)
      ?? text.match(/await api\.put\(`\/members\/\$\{[^}]+\}\/location`, bgPayload\)/g)
      ?? [];
    const successRecords = text.match(/await recordLocationUploadSuccess\(\)/g) ?? [];

    expect(locationPuts).toHaveLength(expectedCalls);
    expect(successRecords).toHaveLength(expectedCalls);
  });

  it('uses the shared recorder for both native success callbacks', () => {
    const text = source('src/locationEngine.ts');

    expect(text.match(/recordLocationUploadSuccess\(\)/g)).toHaveLength(2);
    expect(text).not.toMatch(
      /status === 200 \|\| evt\?\.status === 201[^}]+recordLocationUploadSuccess/s,
    );
  });
});