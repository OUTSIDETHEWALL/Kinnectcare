import { Platform } from 'react-native';
import { setPendingInvite } from './pendingInvite';

const INVITE_TOKEN_RE = /^(?:INV|KINN)-[A-Z0-9]+$/;
export const INSTALL_REFERRER_STARTUP_TIMEOUT_MS = 2_000;

export function inviteTokenFromInstallReferrer(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const params = new URLSearchParams(referrer);
    const token = String(params.get('invite_token') || '').trim().toUpperCase();
    return INVITE_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function captureInstallReferrerInvite(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;

  try {
    // Dynamic import is required: older OTA-compatible binaries do not contain
    // this native module and must continue to boot without evaluating it.
    const { PlayInstallReferrer } = await import('react-native-play-install-referrer');
    return await new Promise((resolve) => {
      let startupResolved = false;
      let callbackHandled = false;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;

      const finishStartup = (token: string | null) => {
        if (startupResolved) return;
        startupResolved = true;
        if (startupTimer) clearTimeout(startupTimer);
        resolve(token);
      };

      // Install Referrer is optional attribution data, not an authentication
      // dependency. Some Play Store / OEM service states never deliver either
      // callback, so startup must continue after a short bounded wait.
      startupTimer = setTimeout(() => {
        console.warn('[invite-accept] install_referrer_timeout');
        finishStartup(null);
      }, INSTALL_REFERRER_STARTUP_TIMEOUT_MS);

      try {
        PlayInstallReferrer.getInstallReferrerInfo(async (info, error) => {
          if (callbackHandled) return;
          callbackHandled = true;

          if (error) {
            console.warn('[invite-accept] install_referrer_unavailable', {
              responseCode: error.responseCode ?? null,
              message: error.message || 'unknown',
            });
            finishStartup(null);
            return;
          }

          const token = inviteTokenFromInstallReferrer(info?.installReferrer);
          if (!token) {
            console.info('[invite-accept] install_referrer_no_invite');
            finishStartup(null);
            return;
          }

          try {
            // A callback that arrives after the startup timeout may still save
            // the invite for the signup/OTP flow; it simply cannot hold boot.
            await setPendingInvite(token);
            console.info('[invite-accept] install_referrer_captured');
            finishStartup(token);
          } catch (error: any) {
            console.warn('[invite-accept] install_referrer_persist_failed', {
              message: error?.message || String(error),
            });
            finishStartup(null);
          }
        });
      } catch (error: any) {
        console.warn('[invite-accept] install_referrer_start_failed', {
          message: error?.message || String(error),
        });
        finishStartup(null);
      }
    });
  } catch (error: any) {
    console.warn('[invite-accept] install_referrer_module_unavailable', {
      message: error?.message || String(error),
    });
    return null;
  }
}