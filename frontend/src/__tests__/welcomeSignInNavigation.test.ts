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

  it('records truthful Welcome milestones without changing destination routes', () => {
    const welcome = source('app/index.tsx');

    expect(welcome).toContain("recordNativeStartupCheckpoint('welcome_render_committed')");
    expect(welcome).toContain("recordNativeStartupCheckpoint('welcome_interactive')");
    expect(welcome).toContain("recordNativeStartupCheckpoint('welcome_first_button_press_received')");
    expect(welcome).toContain("recordNativeStartupCheckpoint('welcome_login_navigation_requested')");
    expect(welcome).toContain("router.push('/(auth)/signup')");
    expect(welcome).toContain("router.push('/(auth)/login')");
    expect(welcome).toContain("router.push('/(auth)/join-family')");
  });

  it('uses post-layout rather than a timer for the interactive milestone', () => {
    const welcome = source('app/index.tsx');

    expect(welcome).toContain('onLayout={onWelcomeLayout}');
    expect(welcome).not.toContain('setTimeout');
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