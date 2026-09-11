import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('Stripe checkout return URL contract', () => {
  it('returns success and cancellation to the installed app upgrade route', () => {
    const upgrade = source('app/upgrade.tsx');
    const api = source('src/api.ts');

    expect(upgrade).toContain("const returnUrl = 'kinnship://upgrade'");
    expect(upgrade).not.toContain('`${base}/upgrade`');
    expect(api).toContain('`${returnUrl}?status=success`');
    expect(api).toContain('`${returnUrl}?status=cancel`');
  });

  it('never targets the Railway upgrade path', () => {
    const upgrade = source('app/upgrade.tsx');

    expect(upgrade).not.toContain('EXPO_PUBLIC_BACKEND_URL');
    expect(upgrade).not.toContain('railway.app/upgrade');
  });
});