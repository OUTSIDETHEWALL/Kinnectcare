import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('Welcome Sign In navigation contract', () => {
  it('routes the Sign In button to the passwordless login screen', () => {
    const welcome = source('app/index.tsx');

    expect(welcome).toContain('testID="welcome-login-link"');
    expect(welcome).toContain("router.push('/(auth)/login')");
  });

  it('does not redirect an active auth route back to onboarding', () => {
    const rootLayout = source('app/_layout.tsx');

    expect(rootLayout).toContain(
      'if (!user && needsOnboarding && !inAuthGroup && !isOnboarding && !isPublic)',
    );
  });

  it('does not redirect an active auth route back to a cold-start invite', () => {
    const rootLayout = source('app/_layout.tsx');

    expect(rootLayout).toContain(
      'if (!user && coldStartInviteToken && !inAuthGroup && !isInviteRoute && !isPublic)',
    );
  });
});