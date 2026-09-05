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

  it('visibly instruments both Welcome buttons at every press phase', () => {
    const welcome = source('app/index.tsx');

    for (const button of ['create-family', 'sign-in']) {
      expect(welcome).toContain(`handlePressIn('${button}')`);
      expect(welcome).toContain(`handlePressOut('${button}')`);
      expect(welcome).toContain(`'${button}', 'onPress'`);
    }
    expect(welcome).toContain("'PRESSED'");
    expect(welcome).toContain('styles.pressProbe');
  });

  it('shows an unmistakable non-interactive production bundle marker', () => {
    const welcome = source('app/index.tsx');

    expect(welcome).toContain('BUNDLE CHECK');
    expect(welcome).toContain('EMBEDDED BUILD 64');
    expect(welcome).toContain('OTA ACTIVE');
    expect(welcome).toContain('Updates.isEmbeddedLaunch');
    expect(welcome).toContain('Updates.updateId');
    expect(welcome).toContain('Updates.channel');
    expect(welcome).toContain('Updates.runtimeVersion');
    expect(welcome).toContain('Device.manufacturer');
    expect(welcome).toContain('Device.modelName');
    expect(welcome).toContain('Platform.Version');
    expect(welcome).toContain('pointerEvents="none"');
    expect(welcome).toContain('styles.bundleMarker');
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