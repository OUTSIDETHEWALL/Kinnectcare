import { Platform } from 'react-native';
import { setPendingInvite } from './pendingInvite';

const INVITE_TOKEN_RE = /^(?:INV|KINN)-[A-Z0-9]+$/;

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
      PlayInstallReferrer.getInstallReferrerInfo(async (info, error) => {
        if (error) {
          console.warn('[invite-accept] install_referrer_unavailable', {
            responseCode: error.responseCode ?? null,
            message: error.message || 'unknown',
          });
          resolve(null);
          return;
        }

        const token = inviteTokenFromInstallReferrer(info?.installReferrer);
        if (!token) {
          console.info('[invite-accept] install_referrer_no_invite');
          resolve(null);
          return;
        }

        await setPendingInvite(token);
        console.info('[invite-accept] install_referrer_captured');
        resolve(token);
      });
    });
  } catch (error: any) {
    console.warn('[invite-accept] install_referrer_module_unavailable', {
      message: error?.message || String(error),
    });
    return null;
  }
}