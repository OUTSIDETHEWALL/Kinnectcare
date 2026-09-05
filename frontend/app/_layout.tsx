import { Stack, useRouter, useSegments, usePathname } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState, useRef } from 'react';import { View, ActivityIndicator, AppState, Platform, Linking, Alert } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Colors } from '../src/theme';
import { registerForPushNotifications, setupNotificationsForOS, useNotificationListeners, setAppReadyForDeepLink, refreshPushTokenIfStale, dismissStaleAreYouOkNotifs } from '../src/push';
import { isOnboardingDone, markOnboardingDone } from '../src/onboardingStore';
import { hasPinForUser, isUnlockedNow } from '../src/pinAuth';
import {
  isAppLockEnabled,
  markAppLockMigrationNoticeShown,
  needsAppLockUnlock as shouldRequireAppLockUnlock,
  shouldShowAppLockMigrationNotice,
} from '../src/appLock';
import { startBackgroundLocation, stopBackgroundLocation } from '../src/backgroundLocation';
import { configureBatteryTask, BATTERY_OPT_PROMPTED_KEY } from '../src/batteryTask';
import { refreshLocationIfStale, setMyMemberId, setMyUserId } from '../src/locationRefresh';
import * as locationEngine from '../src/locationEngine';
import * as leonidas from '../src/leonidas';
import * as memberStore from '../src/store/memberStore';
import { api, getCurrentToken, subscribeToTokenChanges } from '../src/api';
import { logPipelineEvent } from '../src/refreshPipelineLog';
import {
  loadDisclaimerAck,
  subscribeDisclaimerAck,
  getDisclaimerAckSync,
} from '../src/disclaimerStore';
import { logResumeDecision, isAlertDismissed } from '../src/resumeDiagnostics';
import { setActiveEmergency } from '../src/activeEmergency';
import {
  setPendingInvite,
  getPendingInvite,
  isInviteConsumed,
} from '../src/pendingInvite';
import { isPermissionsHandled } from '../src/permissionsStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logStartupEvent } from '../src/startupDiagnostics';

function RootNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const pathname = usePathname();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // App Lock is optional and off by default. A saved legacy PIN alone must
  // never hold up session restoration, deep links, or monitoring startup.
  const [appLockChecked, setAppLockChecked] = useState(false);
  const [needsAppLockUnlock, setNeedsAppLockUnlock] = useState(false);
  // Health disclaimer gate — first-launch only.  Acknowledgment stored in
  // AsyncStorage under DISCLAIMER_ACK_KEY.  Required for Google Play
  // medical-disclaimer compliance (v1.1.7).
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [needsDisclaimer, setNeedsDisclaimer] = useState(false);
  // Permission onboarding gate — shown once per install after the user
  // authenticates for the first time.  Fires the OS location and
  // notification dialogs with emotional, family-focused context.
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [needsPermissions, setNeedsPermissions] = useState(false);
  // Cold-start deep links must be resolved before RootNav makes its first
  // route decision. Otherwise the generic onboarding/disclaimer gates can
  // navigate away while the invite token is still being persisted.
  const [initialLinkChecked, setInitialLinkChecked] = useState(false);
  const [coldStartInviteToken, setColdStartInviteToken] = useState<string | null>(null);
  const routeDecisionRef = useRef(0);

  const logRootDecision = (
    reason: string,
    toRoute: string | null,
    outcome: 'navigate' | 'hold' | 'ready',
  ) => {
    logStartupEvent({
      phase: 'root_navigation_decision',
      event: 'root_navigation_evaluated',
      route: toRoute,
      reason,
      outcome,
      details: {
        decision: ++routeDecisionRef.current,
        currentRoute: pathname || '/',
        authenticated: !!user,
        authLoading: loading,
        onboardingChecked,
        needsOnboarding,
        appLockChecked,
        needsAppLockUnlock,
        disclaimerChecked,
        needsDisclaimer,
        permissionsChecked,
        needsPermissions,
      },
    });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      logStartupEvent({
        phase: 'final_route_committed',
        event: 'route_stable_750ms',
        route: pathname || '/',
        outcome: user ? 'authenticated' : 'unauthenticated',
        details: { authLoading: loading },
      });
    }, 750);
    return () => clearTimeout(timer);
  }, [pathname, user, loading]);

  useEffect(() => {
    // Cold-start load + subscribe-for-future-changes.  Runs ONCE on
    // mount.  The subscriber fires when the disclaimer screen calls
    // setDisclaimerAck() so we flip needsDisclaimer to false in the
    // same tick the user taps "I Understand" — preventing the bounce-
    // back-to-disclaimer loop that v1.1.7 hit.
    let mounted = true;
    (async () => {
      const acked = await loadDisclaimerAck();
      if (mounted) {
        setNeedsDisclaimer(!acked);
        setDisclaimerChecked(true);
      }
    })();
    const unsubscribe = subscribeDisclaimerAck(() => {
      if (!mounted) return;
      const acked = getDisclaimerAckSync();
      setNeedsDisclaimer(!acked);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    (async () => {
      const done = await isOnboardingDone();
      setNeedsOnboarding(!done);
      setOnboardingChecked(true);
    })();
  }, []);

  // Permission onboarding — read once on mount.  The permissions screen
  // calls markPermissionsHandled() + router.replace('/dashboard') on
  // completion; the routing effect re-reads from storage on the next
  // segments-change trigger to confirm the gate has been cleared.
  useEffect(() => {
    (async () => {
      const handled = await isPermissionsHandled();
      setNeedsPermissions(!handled);
      setPermissionsChecked(true);
    })();
  }, []);

  // ============================================================
  //  v1.2.1 (build 41) — Lifecycle diagnostics
  // ============================================================
  //  Logs `app_launched` once on mount and `app_foregrounded` /
  //  `app_backgrounded` on every AppState transition.  These entries
  //  land in the same ring buffer as the location-engine events so
  //  the Diagnostics screen can show the FULL timeline (e.g.
  //  "app_backgrounded at 21:14, no SDK heartbeat since 21:13 →
  //  engine not running in background").
  useEffect(() => {
    // Task #21 Deliverable 1 — inject device identity so engine_snapshot_stale
    // events carry device model, build number, and OTA group ID without needing
    // native module imports in locationEngine.ts itself.
    locationEngine.setDeviceInfo({
      model:       (Constants.deviceName as string | null) ?? null,
      buildNumber: (Constants.expoConfig?.ios?.buildNumber as string | null)
                   ?? (Constants as any)?.nativeBuildVersion
                   ?? null,
      otaUpdateId: (Updates as any)?.updateId ?? null,
      otaChannel:  (Updates as any)?.channel  ?? null,
    });

    void locationEngine.logEvent('app_launched', {
      platform: Platform.OS,
      initialAppState: AppState.currentState,
    });
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void locationEngine.logEvent('app_foregrounded');
        // Task #21 — Before/After snapshot for root cause investigation.
        //
        // If a member's location is stale and opening the app immediately
        // restores uploads, the diff between the snapshot fired by the
        // stale-detection heartbeat and THIS snapshot identifies the
        // exact restoring action — without needing to guess.
        //
        // Specifically: if listeners_attached is true here but the JS
        // heartbeat snapshot showed callbacks had gone silent, something
        // in the foreground path re-connected the SDK bridge even though
        // the listenersAttached guard never reset.
        void (async () => {
          try {
            const [pts, sdkSt] = await Promise.all([
              locationEngine.getPipelineTimestamps(),
              locationEngine.getState(),
            ]);
            const now = Date.now();
            void locationEngine.logEvent('app_foregrounded_snapshot', {
              listeners_attached:  locationEngine.isListenersAttached(),
              sdk_enabled:         sdkSt.enabled,
              sdk_isMoving:        sdkSt.isMoving,
              sdk_trackingMode:    sdkSt.trackingMode,
              motion_age_ms:       pts.motion             !== null ? now - pts.motion             : null,
              activity_age_ms:     pts.activity           !== null ? now - pts.activity           : null,
              location_age_ms:     pts.location           !== null ? now - pts.location           : null,
              hb_js_age_ms:        pts.heartbeat_js       !== null ? now - pts.heartbeat_js       : null,
              hl_inv_age_ms:       pts.headless_invoked   !== null ? now - pts.headless_invoked   : null,
              hl_hb_age_ms:        pts.headless_heartbeat !== null ? now - pts.headless_heartbeat : null,
              http_att_age_ms:     pts.http_attempt       !== null ? now - pts.http_attempt       : null,
              http_ok_age_ms:      pts.http_success       !== null ? now - pts.http_success       : null,
            });
          } catch (_e) { /* never abort app lifecycle for a diagnostic snapshot */ }
        })();
      } else if (next === 'background' || next === 'inactive') {
        void locationEngine.logEvent('app_backgrounded', { state: next });
      }
    });
    return () => {
      try { sub.remove(); } catch (_e) {}
    };
  }, []);

  // ==========================================================================
  // Build #60 — Deep-link → pending-invite → auto-join wiring.
  //
  // The single source of truth for "the user tapped Accept Invitation
  // somewhere and we need to route them into the family group" lives
  // here in RootNav so BOTH the cold-start (app was not running when
  // they tapped) and the warm-start (app was in background) paths
  // share exactly one implementation.
  //
  // What we do:
  //   1. On mount, check Linking.getInitialURL() — this returns the
  //      URL that launched the app (or null on regular launches).
  //   2. Register a Linking.addEventListener('url', ...) for any
  //      subsequent link taps while the app is running.
  //   3. For every URL that matches kinnship://invite/{token} or the
  //      https-landing-page equivalent, extract the token and:
  //         a. persist it to AsyncStorage via setPendingInvite — so
  //            even if the app quits before the user finishes
  //            signing up, we still remember what to join.
  //         b. if the user is ALREADY authenticated, immediately
  //            POST /family-group/join and refresh — this is the
  //            "existing user taps invite from a family member"
  //            scenario.  Otherwise the auto-consume in
  //            AuthContext.verifyOtp will pick it up as soon as
  //            they finish signing up.
  //         c. push the client at /invite/{token} so the invite/
  //            [token].tsx screen renders the friendly "Welcome to
  //            the family, tap Accept" preview.
  //
  // The token extraction regex tolerates:
  //   • kinnship://invite/INV-XXXXX
  //   • kinnship://invite/INV-XXXXX?anything
  //   • kinnship:/invite/INV-XXXXX  (some Android intents drop a slash)
  //   • https://<host>/invite/INV-XXXXX  (Universal-link path)
  const lastRoutedInviteRef = useRef<string | null>(null);
  useEffect(() => {
    const extractInviteToken = (url: string | null): string | null => {
      if (!url) return null;
      // Case-insensitive match; the token itself must match the
      // KINN- or INV- prefix and alnum body.
      const m = url.match(/(?:kinnship:\/{1,2}|https?:\/\/[^/]+\/)invite\/((?:INV|KINN)-[A-Z0-9]+)/i);
      return m ? m[1].toUpperCase() : null;
    };

    const consumeInviteUrl = async (url: string | null, coldStart = false) => {
      const token = extractInviteToken(url);
      logStartupEvent({
        phase: 'deep_link_processing',
        event: 'invite_url_parsed',
        outcome: token ? 'invite_token_present' : 'no_invite_token',
        details: { urlPresent: !!url },
      });
      if (!token) return;
      logStartupEvent({
        phase: 'consumed_token_check',
        event: 'consumed_token_check_started',
        reason: 'deep_link',
      });
      const consumed = await isInviteConsumed(token);
      logStartupEvent({
        phase: 'consumed_token_check',
        event: 'consumed_token_check_completed',
        outcome: consumed ? 'consumed' : 'not_consumed',
      });
      if (consumed) {
        console.info('[invite-accept] consumed_launch_ignored');
        logStartupEvent({
          phase: 'deep_link_processing',
          event: 'invite_url_ignored',
          reason: 'token_already_consumed',
        });
        return;
      }
      // Persist first — the safest thing we can do.  Everything below
      // is best-effort.
      await setPendingInvite(token);
      if (coldStart) setColdStartInviteToken(token);
      logStartupEvent({
        phase: 'deep_link_processing',
        event: 'pending_invite_saved',
        outcome: 'invite_route_scheduled',
      });

      // Zero-friction onboarding: never auto-join silently.
      // Route directly to /invite/{token} so the user always sees
      // the explicit "Join Family" confirmation card, regardless of
      // whether they are already authenticated.  The card handles
      // the join for authenticated users and hands off to signup for
      // unauthenticated ones.  verifyOtp() auto-joins after the
      // account is created so the pending token is always consumed.
      // RootNav owns the cold-start route after all launch gates have
      // settled. A timer here used to race disclaimer/onboarding navigation.
      // Warm links arrive after RootNav is ready and can route immediately.
      if (!coldStart && lastRoutedInviteRef.current !== token) {
        lastRoutedInviteRef.current = token;
        try {
          logStartupEvent({
            phase: 'root_navigation_decision',
            event: 'invite_route_requested',
            route: '/invite/[token]',
            reason: 'warm_deep_link',
            outcome: 'navigate',
          });
          router.push(`/invite/${token}` as any);
        } catch (_e) {}
      }
    };

    // 1) Cold start — was the app launched via a link?
    (async () => {
      try {
        const initial = await Linking.getInitialURL();
        logStartupEvent({
          phase: 'deep_link_processing',
          event: 'initial_url_loaded',
          outcome: initial ? 'url_present' : 'no_url',
        });
        if (initial) await consumeInviteUrl(initial, true);
      } catch (_e) { /* non-fatal */ }
      finally {
        // Even a malformed or unavailable initial URL must not leave the
        // launch gate waiting forever.
        setInitialLinkChecked(true);
      }
    })();

    // 2) Warm start — user taps a link while the app is running.
    const sub = Linking.addEventListener('url', ({ url }) => {
      void consumeInviteUrl(url);
    });
    return () => {
      try { sub.remove(); } catch (_e) {}
    };
    // Initial URL processing is intentionally mount-only. AuthContext owns
    // auto-joining a pending invite after OTP; replaying getInitialURL when
    // `user` changes would re-run cold-start routing during sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==========================================================================

  // Re-evaluate the optional App Lock whenever the authenticated account
  // changes. A legacy PIN does not activate the gate by itself: only the
  // explicit App Lock preference does. This keeps the session and all native
  // safety work independent from the foreground privacy choice.
  useEffect(() => {
    let cancelled = false;
    setAppLockChecked(false);
    (async () => {
      if (!user?.id) {
        if (cancelled) return;
        setNeedsAppLockUnlock(false);
        setAppLockChecked(true);
        return;
      }
      const [enabled, hasPin] = await Promise.all([
        isAppLockEnabled(user.id),
        hasPinForUser(user.id),
      ]);
      if (cancelled) return;
      // A missing PIN under App Lock is a corrupted/incomplete local setup.
      // Fail open to the authenticated session rather than trapping someone
      // behind a screen they cannot unlock; Settings can recreate the PIN.
      setNeedsAppLockUnlock(shouldRequireAppLockUnlock(enabled, hasPin, isUnlockedNow(user.id)));
      setAppLockChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Existing PIN users get this explanation once, after normal onboarding
  // gates have cleared. It does not change their PIN, session, or monitoring.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (
        !user?.id ||
        !appLockChecked ||
        needsAppLockUnlock ||
        needsOnboarding ||
        needsPermissions ||
        needsDisclaimer
      ) return;
      const hasLegacyPin = await hasPinForUser(user.id);
      if (cancelled || !(await shouldShowAppLockMigrationNotice(user.id, hasLegacyPin))) return;
      await markAppLockMigrationNoticeShown(user.id);
      if (cancelled) return;
      Alert.alert(
        'App Lock is now optional',
        "Kinnship now uses your phone's built-in security by default. Your PIN is still saved if you want extra protection — turn on App Lock anytime in Me → Security.",
      );
    })();
    return () => { cancelled = true; };
  }, [user?.id, appLockChecked, needsAppLockUnlock, needsOnboarding, needsPermissions, needsDisclaimer]);

  useNotificationListeners((data) => {
    // Deep-link by notification type. Uses router.replace (not push)
    // so the user can't accidentally hit "back" and land on a
    // half-rendered intermediate screen during cold-start. The
    // pending-deep-link queue in push.ts has already guaranteed
    // that this callback only fires AFTER the auth + PIN gate in
    // RootNav has cleared, so there's no router race anymore.
    const t = data?.type;
    const subtype = data?.subtype;
    const stage = data?.stage;
    // P6 BETA DIAGNOSTICS — capture routing decision pre-navigation.
    // TODO: remove this block + the routeDiagnostics import once
    // stabilization sprint completes.  Logs to AsyncStorage only
    // (no network, no PII), bounded at 50 entries.
    const __logRoute = (toRoute: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const diag = require('../src/routeDiagnostics');
        void diag.logRouteDecision({
          type: typeof t === 'string' ? t : 'unknown',
          loggedIn: !!user?.id,
          hasPin: appLockChecked ? !needsAppLockUnlock : null,
          pinUnlocked: !needsAppLockUnlock,
          fromSegment: (segments && (segments as string[]).join('/')) || 'unknown',
          toRoute,
          reason: 'tap',
          alertId: typeof data?.alert_id === 'string' ? (data.alert_id as string) : null,
        });
      } catch (_e) {}
    };
    if ((t === 'medication' && (subtype === 'self_due' || !subtype)) ||
        (t === 'routine')) {
      __logRoute('/(modals)/acknowledge');
      try {
        router.replace({
          pathname: '/(modals)/acknowledge',
          params: {
            type: t,
            reminder_id: data?.reminder_id || '',
            title: data?.title || '',
            dosage: data?.dosage || '',
            member_name: data?.member_name || '',
            stage: stage || '',
          },
        } as any);
      } catch (_e) {
        router.replace('/(tabs)/alerts');
      }
      return;
    }
    if (t === 'medication' && (subtype === 'family_alert' || stage === 'family_alert')) {
      // Family alert → also open the acknowledge panel but in
      // "checked on them" mode (the screen detects this via stage).
      try {
        router.replace({
          pathname: '/(modals)/acknowledge',
          params: {
            type: 'medication',
            reminder_id: data?.reminder_id || '',
            title: data?.title || '',
            member_name: data?.member_name || '',
            stage: 'family_alert',
          },
        } as any);
      } catch (_e) {
        router.replace('/(tabs)/alerts');
      }
      return;
    }
    if (t === 'sos') {
      // Deep-link straight to the SOS incident screen for the specific
      // alert.  Falls back to the alerts list when no alert_id is present
      // (legacy build or rare missing-id race).
      const aid = data?.alert_id;
      if (aid) {
        __logRoute(`/alert/${aid}`);
        router.replace({ pathname: '/alert/[id]', params: { id: aid } } as any);
      } else {
        __logRoute('/(tabs)/alerts');
        router.replace('/(tabs)/alerts');
      }
    }
    if (t === 'missed_checkin') {
      // Missed check-ins route to their own dedicated screen — NOT the
      // SOS incident screen.  A missed check-in is a welfare concern,
      // not an emergency; the UI must reflect that.
      const aid = data?.alert_id;
      if (aid) {
        __logRoute(`/missed-checkin/${aid}`);
        router.replace({ pathname: '/missed-checkin/[id]', params: { id: aid } } as any);
      } else {
        __logRoute('/(tabs)/alerts');
        router.replace('/(tabs)/alerts');
      }
    }
    if (t === 'are_you_ok_request') {
      // Build XX — "Are You OK?" request arrives on the member's device.
      // Route to the response screen; _action drives auto-submit vs. prompt.
      const rid = data?.request_id;
      const mid = data?.member_id;
      const act = data?._action; // 'im_ok' | 'need_help' | undefined
      __logRoute('/are-you-ok-response');
      try {
        router.replace({
          pathname: '/are-you-ok-response',
          params: {
            requestId: rid || '',
            memberId: mid || '',
            ...(act ? { action: act } : {}),
          },
        } as any);
      } catch (_e) {
        router.replace('/(tabs)/dashboard');
      }
    }
    if (t === 'are_you_ok_response' || t === 'checkin') {
      // Build XX — caregiver receives confirmation that the member is OK.
      // Just refresh the dashboard data; no navigation needed.
      // The 30s foreground poll will pick this up on the next tick automatically,
      // but we can trigger an immediate refresh here for instant UI update.
      // Dynamic import to avoid circular deps.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const store = require('../src/store/memberStore');
        store.fetchAll().catch(() => {});
      } catch (_e) {}
    }
  });

  useEffect(() => {
    // OS-side notification setup runs on EVERY launch, BEFORE auth.
    // This guarantees the notification channels (meds_v2, routines,
    // sos, ...) and categories (action buttons) exist on the device
    // before any push can arrive — fixing the #1 pre-launch safety
    // bug where medication / check-in / SOS pushes were
    // silently dropped when the app was killed or the user was
    // logged out, because the channels were only created
    // post-authentication.
    setupNotificationsForOS().catch(() => {});
  }, []);

  useEffect(() => {
    if (user) {
      registerForPushNotifications().catch(() => {});
    }
  }, [user?.id]);

  // ============================================================
  //  Auto push-token refresh on app foreground (v1.2.1)
  // ============================================================
  //
  // A member reported SOS deliveries silently failing after extended
  // idle periods (multi-day on-charger). Root cause: Expo/FCM
  // occasionally rotates the device push token AND the JS process
  // can stay alive across days without any useEffect re-running —
  // so the existing `useEffect([user?.id])` registration above
  // never re-fires. The backend keeps a stale token, the push
  // relay drops it silently.
  //
  // Fix: listen for AppState 'active' transitions and silently
  // re-register. `refreshPushTokenIfStale` self-throttles to once
  // per 30 minutes per successful sync (see push.ts), so rapid
  // bg/fg flips don't hammer Expo or our /auth/push-token.
  //
  // We do NOT react to 'inactive' or 'background' — only fresh
  // 'active' transitions. We also gate on a signed-in user (no
  // token to authenticate the API call otherwise).
  useEffect(() => {
    if (!user?.id) return;
    // Fire once on mount so the throttle is primed; the existing
    // useEffect above already triggers an initial register, this
    // is the no-op fallback for cases where AppState was already
    // 'active' before the user signed in (e.g. cold-start via
    // notification tap → OTP → returns to 'active').
    refreshPushTokenIfStale('mount').catch(() => {});
    // Build XX — sweep stale are_you_ok_response / checkin confirmation
    // notifications on mount (handles notifications that arrived while
    // the app was killed and have now aged past 8 hours).
    dismissStaleAreYouOkNotifs().catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshPushTokenIfStale('foreground').catch(() => {});
        // Build XX — sweep stale confirmation notifications on every
        // foreground resume.  8-hour default: caregiver has a full
        // overnight window to see the confirmation; tray is clean by
        // the following morning.
        dismissStaleAreYouOkNotifs().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  Build 50 hotfix — Hardened SOS auto-resume
  // ============================================================
  //
  //  When the app becomes foreground, we ONLY auto-navigate the user
  //  to an incident screen when ALL of the following hold:
  //     • /alerts returned a NEWEST alert of type='sos'
  //     • resolved !== true  AND  acknowledged !== true
  //     • age (now − created_at) ≤ 5 minutes
  //     • id NOT in the session-dismissed set (see resumeDiagnostics)
  //     • pathname NOT already on /alert/<same id>
  //     • ≥3 s since the last check (cooldown)
  //
  //  If we find an unresolved-but-stale (>5 min) SOS, we DON'T yank
  //  the user — we surface a Dashboard banner via activeEmergency
  //  store instead, and they can tap into the incident screen on
  //  their own terms.  This prevents "trapped by a 4h-old alert"
  //  after the user has already moved on.
  //
  //  Every decision — resume, banner, or suppress — is logged to
  //  the resumeDiagnostics ring buffer with a `reason` so post-
  //  mortem investigation is evidence-based (no more guessing why
  //  the auto-resume fired).
  //
  //  A 404 anywhere in the pipeline (GET or resolve) is a signal
  //  the alert no longer exists; alert/[id].tsx marks the id
  //  dismissed for this session, sets activeEmergency to null,
  //  and routes back to Dashboard.  That state is then honoured
  //  here on the next AppState transition.
  // ============================================================
  const smartResumeCooldownRef = useRef<number>(0);
  useEffect(() => {
    if (!user?.id) {
      logResumeDecision({ reason: 'no-user' });
      return;
    }
    const AUTO_RESUME_MAX_AGE_MS = 5 * 60 * 1000; // 5 min

    const checkAndResume = async () => {
      const now = Date.now();
      if (now - smartResumeCooldownRef.current < 3000) {
        logResumeDecision({ reason: 'cooldown', fromPathname: pathname || null });
        return;
      }
      smartResumeCooldownRef.current = now;

      let list: any[] = [];
      try {
        const res = await api.get('/alerts');
        list = res?.data || [];
      } catch (e: any) {
        logResumeDecision({
          reason: 'fetch-failed',
          fromPathname: pathname || null,
          detail: e?.message || 'unknown',
        });
        return;
      }

      // Consider only SOS alerts that are NEITHER resolved NOR ack'd,
      // and not already dismissed in this session.  Sort newest-first.
      const candidates = list
        .filter((a) => a?.type === 'sos' && a?.resolved !== true && a?.acknowledged !== true)
        .filter((a) => !isAlertDismissed(a?.id))
        .sort((a, b) => {
          const ta = a?.created_at ? new Date(a.created_at).getTime() : 0;
          const tb = b?.created_at ? new Date(b.created_at).getTime() : 0;
          return tb - ta;
        });
      const activeSos = candidates[0];

      if (!activeSos?.id) {
        setActiveEmergency(null);
        logResumeDecision({ reason: 'no-cached-alert', fromPathname: pathname || null });
        return;
      }

      const createdMs = activeSos.created_at ? new Date(activeSos.created_at).getTime() : 0;
      const ageMs = createdMs ? now - createdMs : Number.POSITIVE_INFINITY;

      // Update the shared active-emergency store so Dashboard can
      // render its banner regardless of the resume decision below.
      setActiveEmergency({
        id: activeSos.id,
        member_id: activeSos.member_id,
        member_name: activeSos.member_name,
        created_at: activeSos.created_at,
        latitude: activeSos.latitude ?? null,
        longitude: activeSos.longitude ?? null,
        ageMs,
      });

      // Already viewing this alert → don't yank them again.
      if (pathname && pathname.startsWith(`/alert/${activeSos.id}`)) {
        logResumeDecision({
          reason: 'already-viewing',
          alertId: activeSos.id,
          ageMs,
          fromPathname: pathname || null,
        });
        return;
      }

      // Stale — show the banner on the Dashboard instead of yanking.
      if (ageMs > AUTO_RESUME_MAX_AGE_MS) {
        logResumeDecision({
          reason: 'stale-alert',
          alertId: activeSos.id,
          ageMs,
          fromPathname: pathname || null,
          detail: `age ${Math.round(ageMs / 1000)}s > 5min`,
        });
        return;
      }

      // Fresh + unresolved + unacknowledged + not-dismissed → resume.
      logResumeDecision({
        reason: 'resumed',
        alertId: activeSos.id,
        ageMs,
        fromPathname: pathname || null,
      });
      router.replace(`/alert/${activeSos.id}`);
    };

    // Fire once on mount so users who cold-start (AppState never
    // 'changes' to active — it starts active) still get a validation
    // pass.  Delayed 800 ms so /me + auth-context settle first.
    const initialTimer = setTimeout(checkAndResume, 800);

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        setTimeout(checkAndResume, 400);
      }
    });
    return () => {
      clearTimeout(initialTimer);
      sub.remove();
    };
  }, [user?.id, pathname, router]);

  // ============================================================
  //  v1.2.2 — Cache "my member id" + foreground location refresh
  // ============================================================
  //
  //  A member's location went stale on the caregiver's dashboard despite the
  //  backend holding fresh data.  Adding (a) a 60-second visible-tab
  //  poll, (b) an AppState 'active' refetch, and (c) a notification-
  //  arrival refetch on Dashboard handles the read side.  This
  //  effect handles the corresponding WRITE side — every foreground
  //  transition (on the member's own phone) also uploads a fresh GPS fix
  //  to /members/{id}/location, so even if the OS-owned background
  //  task has been throttled into silence by Android App Standby,
  //  the backend stays current.
  //
  //  We need a member_id to know whose row to update.  Fetch it once
  //  after login by matching members[].user_id === current user.id
  //  (same logic as dashboard.tsx) and cache it via
  //  setMyMemberId() — refreshLocationIfStale reads from that
  //  cache, so we don't hit /members on every foreground.
  useEffect(() => {
    if (!user?.id) {
      setMyMemberId(null).catch(() => {});
      setMyUserId(null).catch(() => {});
      return;
    }
    let cancelled = false;
    // Cache user_id immediately (synchronously usable on the next bg
    // task tick) so a slow /members fetch doesn't leave the bg log
    // without a writer identity field for the first few minutes.
    setMyUserId(user.id).catch(() => {});
    // Resolve and cache the caller's member row ID.
    //
    // Retries once after 2 s to cover the race between verify-otp
    // completing (which writes ensure_self_member_row on the backend
    // and returns the JWT) and the first member-list fetch landing
    // here.  Without the retry, a fresh invite-path join can hit
    // GET /members before the DB write commits — returning an empty
    // list, leaving kc_my_member_id_v1 null, and hiding the Profile
    // section on the Me tab until the next app restart.
    //
    // Build 47 note preserved: routing through the canonical store
    // both resolves the member ID AND hydrates the store before
    // Dashboard mounts, so the first paint reads real data.
    async function resolveMyMemberId(attempt: number): Promise<void> {
      try {
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        const me = (arr as any[]).find((m: any) => m.user_id === user!.id);
        if (me) {
          await setMyMemberId(me.id);
        } else if (attempt < 2) {
          // Row absent — ensure_self_member_row may not have committed
          // yet.  Wait 2 s and try once more before giving up.
          await new Promise<void>((res) => setTimeout(res, 2000));
          if (!cancelled) await resolveMyMemberId(attempt + 1);
        } else {
          // Second attempt also found nothing — user genuinely has no
          // member row (edge case).  Dashboard's own fetch is the
          // safety net; the next /auth/me refresh will retry this
          // effect if user.id changes.
          await setMyMemberId(null);
        }
      } catch (_e) {
        // Network failure is OK — next /auth/me success will retry.
      }
    }
    resolveMyMemberId(1);
    return () => { cancelled = true; };
  }, [user?.id]);

  // AppState 'active' → push refresh (existing) + location refresh (new).
  // Same listener pattern as the push effect; same self-throttle
  // approach (locationRefresh has its own 60-second floor).
  useEffect(() => {
    if (!user?.id) return;
    // Prime once on mount.
    refreshLocationIfStale('mount').catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshLocationIfStale('foreground').catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  Build 47 — canonical member-store foreground sync
  // ============================================================
  //  Per the Build 47 architectural directive: whenever the
  //  caregiver application returns to the foreground (including
  //  after PIN unlock), automatically perform
  //  `memberStore.fetchAll()`.  This mirrors the observed user
  //  experience where opening Kinnship and entering the PIN
  //  immediately corrected stale location data — the cause was
  //  that the AuthProvider's session bootstrap refetched the
  //  /members endpoint, which then atomically replaced the
  //  member records.  We promote that behaviour from a happy
  //  side-effect into a deliberate guarantee.
  //
  //  The store dedupes concurrent fetchAll() calls, so this is
  //  safe to fire on every 'active' transition without hammering
  //  the API.  It runs on BOTH caregiver and senior devices —
  //  every consumer of useAllMembers()/useMember() gets the
  //  freshest backend record the instant the app comes back to
  //  the foreground.
  // ============================================================
  useEffect(() => {
    if (!user?.id) return;
    // Prime once on mount so the very first paint after PIN unlock
    // already has the freshest data (Charles's PIN-unlock = fresh
    // location refresh in his observed test).
    memberStore.fetchAll().catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        memberStore.fetchAll().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  Foreground 30s refresh — Build XX
  // ============================================================
  //
  //  Problem: the SDK's onHttp → upsertOne path (Build 48) fires
  //  immediately when a background upload completes, but ONLY when
  //  the foreground JS thread is alive.  When the device screen
  //  goes off (iOS suspends the JS runtime), uploads still succeed
  //  in the native SDK layer, but onHttp callbacks never fire.
  //  The dashboard polls at 60 s, but only while IT is the active
  //  screen.  The Me tab, Diagnostics, and Member Detail have no
  //  cross-screen refresh mechanism.
  //
  //  Fix: an interval that runs ONLY while AppState === 'active'
  //  (screen on, app foregrounded).  Battery cost is zero when the
  //  screen is off — the interval stops the instant the app goes to
  //  background.  memberStore.fetchAll() has in-flight dedup, so it
  //  is safe to run alongside any existing per-screen polls without
  //  doubling network requests.
  //
  //  At 30 s the worst-case delay between a successful SDK upload
  //  and the UI reflecting it is 30 s (when the user is actively
  //  looking at the app with the screen on).  When they are not
  //  looking (screen off), the delay doesn't matter because they
  //  can't see it anyway — they will see fresh data within 30 s of
  //  picking the phone back up.
  // ============================================================
  useEffect(() => {
    if (!user?.id) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    function startInterval() {
      if (timer !== null) return; // idempotent
      timer = setInterval(() => {
        // Log the trigger so the Refresh Pipeline section in
        // Diagnostics shows this as a named, attributable event.
        try { logPipelineEvent({ stage: 'dashboard-load', trigger: 'foreground-poll-30s' }); } catch (_e) {}
        memberStore.fetchAll().catch(() => {});
      }, 30_000);
    }

    function stopInterval() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }

    // Start immediately if the app is already in the foreground
    // (covers the normal authenticated session case).
    if (AppState.currentState === 'active') startInterval();

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') startInterval();
      else stopInterval(); // 'background' or 'inactive'
    });

    return () => {
      sub.remove();
      stopInterval();
    };
  }, [user?.id]);

  // ============================================================
  //  Background location foreground service (Fix #1 of v1.2 beta)
  // ============================================================
  //
  // Once the user is authenticated AND we've identified their own
  // member record (the row whose `user_id` matches their user.id),
  // start the OS-owned foreground service that posts location to
  // the backend every ~5 min (and every ~10 sec while SOS is
  // active — Fix #4).  The service surfaces a persistent
  // notification "🛡️ Kinnship is protecting your family" so users
  // can see at a glance that monitoring is on.
  //
  // We gate on member.user_id linkage because the bg task POSTs to
  // /api/members/{memberId}/location — without a member_id we have
  // nowhere to write to.  Caregivers (who own the group but have no
  // member row of their own) intentionally don't run the service —
  // they're tracking, not being tracked.
  //
  // Stops on logout (user becomes null).  Permission UI is handled
  // contextually by startBackgroundLocation() per
  // handle_permissions_contract.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ============================================================
      //  v1.2.2 (build 42) — Legacy engine runtime gate
      // ============================================================
      //  Source code for the expo-location TaskManager path remains in
      //  the repo per the Phase 5 cleanup directive (don't remove yet),
      //  but the legacy engine is NOT invoked at runtime when the
      //  Transistor build is available.  Reason: running both engines
      //  concurrently risks (a) a second foreground-service slot in
      //  Android's notification shade and (b) duplicate PUTs to
      //  /api/members/{id}/location for every fix.  Transistor is the
      //  single source of truth on this build.  If a future fallback
      //  OTA ships without Transistor, this gate returns false and the
      //  legacy path resumes automatically.
      if (locationEngine.isAvailable()) return;

      if (!user?.id) {
        await stopBackgroundLocation();
        return;
      }
      try {
        // Build 47 — canonical store fetch.  The store dedupes
        // concurrent fetchAll() calls so this shares the in-flight
        // promise with the foreground-sync effect above.
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        const me = (arr || []).find((m: any) => m.user_id === user.id);
        if (!me) {
          await stopBackgroundLocation();
          return;
        }
        await startBackgroundLocation(me.id);
      } catch (_e) {
        // Silent — next session retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // ============================================================
  //  v1.4 (Phase 2) — Transistor Location Engine wiring
  // ============================================================
  //
  //  Companion to the legacy expo-location effect above.  Starts the
  //  Transistor `react-native-background-geolocation` engine after
  //  successful authentication AND once we've identified the
  //  current user's member row.  The engine's native HTTP transport
  //  posts location fixes DIRECTLY from the OS service to
  //  `PUT /api/members/{member_id}/location` — no JS round-trip,
  //  no React lifecycle dependency, no Android-Doze suppression.
  //  Payload carries `"provider":"transistor"` so backend logs (and
  //  future analytics) can distinguish engine source from the legacy
  //  expo-location path.
  //
  //  Phase 2 strict-scope decisions (per founder directive):
  //   • Engine runs IN PARALLEL with the legacy expo-location task
  //     during the validation window.  Both write to the same
  //     idempotent latest-wins endpoint.  Legacy is NOT removed —
  //     Phase 5 cleanup decommissions it once Walmart + Overnight
  //     field tests pass.
  //   • Engine is opt-in via runtime detection: if the native module
  //     is absent (web, Expo Go, or a future fallback OTA build),
  //     this effect is a clean no-op and the legacy path remains
  //     authoritative.
  //   • Caregivers who don't own a member row (no `user_id` match
  //     in /members) intentionally don't run the engine — they're
  //     tracking, not being tracked.  Same logic as the legacy
  //     effect above.
  //
  //  JWT sync: subscribes to api.ts's token-change registry so every
  //  saveToken() (verifyOtp + rolling X-Refresh-Token refresh) fans
  //  out to locationEngine.setAuthToken().  Per Transistor docs we
  //  patch the `authorization` config, not the `headers` field —
  //  the SDK's HTTP interceptor rebinds the new token on the next
  //  outgoing PUT.
  //
  //  Build 49 — patrol-lifecycle cleanup.  This effect runs on every
  //  `user?.id` change, including transient flickers during token
  //  rotation / AuthContext re-mounts.  Pre-49 each flicker called
  //  `leonidas.stop()` from the cleanup THEN `leonidas.start()` from
  //  the next run — producing the chatty `patrol-started` /
  //  `patrol-stopped` log pairs even though nothing functional had
  //  changed.  We now track the user.id we last booted Leonidas+engine
  //  for in a ref, and only tear down on a genuine change (logout, or
  //  switching to a different user.id).  Idempotent re-runs are no-ops.
  const engineBootedForUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unsubscribeToken: (() => void) | null = null;
    // Holds a direct teardown handle for the member-row subscriber
    // block so the cleanup function can resolve it immediately on
    // sign-out / effect re-run rather than waiting for the next
    // store write or the 90 s timeout to fire it.
    let cancelWait: (() => void) | null = null;

    (async () => {
      if (!user?.id) {
        // Genuine sign-out — tear everything down.
        if (engineBootedForUserIdRef.current !== null) {
          try { leonidas.stop(); } catch (_e) {}
          await locationEngine.stop();
          engineBootedForUserIdRef.current = null;
        }
        return;
      }
      if (!locationEngine.isAvailable()) {
        // Web / Expo Go / non-Transistor build — legacy engine remains
        // authoritative on this device.  Leonidas is a no-op without
        // the Transistor engine, so we skip starting it here too.
        return;
      }
      // Build 49 — idempotency.  If we already booted Leonidas+engine
      // for this exact user.id, this is a flicker re-run — skip the
      // whole boot dance.  No log noise, no SDK churn, no patrol
      // restart.
      if (engineBootedForUserIdRef.current === user.id) {
        return;
      }
      try {
        // Build 47 — canonical store fetch (shared in-flight with
        // the other two bootstrap effects above via store-level
        // dedupe).
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        let me = (arr || []).find((m: any) => m.user_id === user.id);

        // Path 2 guard — if the member row is not yet visible on cold
        // start, subscribe to store change notifications and wait for it
        // to appear rather than stopping the engine immediately.
        //
        // Why this works: any subsequent fetchAll() — including the
        // dashboard's 60 s poll — writes incoming members through
        // upsertMany(), which fires subscribeMember() callbacks.  When
        // the backend finally has our member row (whether that takes 5 s
        // or 75 s), the next poll delivers it here and boot continues
        // without requiring a sign-out or app restart.
        //
        // WAIT_TIMEOUT_MS is set to 90 s: one full dashboard poll cycle
        // (60 s) plus a 30 s buffer.  A genuine caregiver-only device
        // (no member row in the backend) waits at most 90 s before the
        // engine stops normally — identical to the pre-fix outcome, just
        // slightly delayed.  The device is otherwise fully functional
        // during the wait; no UI is blocked.
        if (!me) {
          const WAIT_TIMEOUT_MS = 90_000;
          me = await new Promise<any>((resolve) => {
            let settled = false;
            const settle = (value: any) => {
              if (settled) return;
              settled = true;
              cancelWait = null; // disarm before teardown
              clearTimeout(waitTimer);
              unsubStore();
              resolve(value);
            };
            const waitTimer = setTimeout(() => settle(null), WAIT_TIMEOUT_MS);
            const unsubStore = memberStore.subscribeMember((m: any) => {
              if (cancelled) { settle(null); return; }
              if (m.user_id === user.id) settle(m);
            });
            // Expose teardown to the effect cleanup function so it can
            // resolve the Promise immediately on sign-out rather than
            // waiting for the next store write or the 90 s timeout.
            cancelWait = () => settle(null);
          });
          if (cancelled) return;
        }

        if (!me) {
          // Timed out — caregiver-only device or genuinely absent
          // member row.  Stop the engine in case it was running from a
          // previous session.
          try { leonidas.stop(); } catch (_e) {}
          await locationEngine.stop();
          engineBootedForUserIdRef.current = null;
          return;
        }
        const jwt = await getCurrentToken();
        const backendBaseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
        if (!jwt || !backendBaseUrl) {
          // Missing config — bail rather than start with broken auth.
          return;
        }
        await locationEngine.start({
          backendBaseUrl,
          memberId: me.id,
          jwt,
        });
        // Leonidas v1.0 — passive health monitor.  Boots in lockstep
        // with the location engine; tears down on sign-out via the
        // cleanup block below.  No-op if already active.
        try { leonidas.start(); } catch (_e) {}
        // Battery subsystem — independent 4-hour refresh via WorkManager
        // (Android) / BGTaskScheduler (iOS).  Runs even when the device
        // hasn't moved and the Transistor SDK is idle.
        configureBatteryTask().catch(() => {});
        // Part 7 — Battery optimization prompt moved to post-onboarding.
        // See useEffect below; fired there so the user has context from
        // onboarding before being asked about a system setting.
        engineBootedForUserIdRef.current = user.id;
        // Subscribe AFTER successful start so any rolling token
        // refresh during the live session flows through.
        unsubscribeToken = subscribeToTokenChanges((tok) => {
          if (tok) {
            locationEngine.setAuthToken(tok).catch(() => {});
          }
        });
      } catch (_e) {
        // Silent — without an authenticated /members fetch we can't
        // identify the member row to upload to.  Next session retries.
      }
    })();

    return () => {
      cancelled = true;
      // If the boot sequence is mid-wait for the member row, resolve
      // the subscriber Promise immediately rather than leaving the
      // subscription live until the next store write or the 90 s
      // timeout.
      if (cancelWait) { cancelWait(); cancelWait = null; }
      if (unsubscribeToken) {
        unsubscribeToken();
        unsubscribeToken = null;
      }
      // Build 49 — do NOT call leonidas.stop() here unconditionally.
      // The cleanup runs on every effect re-evaluation (including
      // flickers during token rotation), and stopping/restarting on
      // each one produced the duplicate patrol-started/stopped log
      // noise we're eliminating in this build.  Real teardown happens
      // in the `!user?.id` branch above when sign-out is genuine.
    };
  }, [user?.id]);

  useEffect(() => {
    if (loading || !initialLinkChecked || !onboardingChecked || !appLockChecked || !disclaimerChecked) {
      logRootDecision('startup_gates_pending', null, 'hold');
      return;
    }
    const inAuthGroup = segments[0] === '(auth)';
    const isWelcome = !segments[0] || segments[0] === ('index' as any);
    const isOnboarding = segments[0] === 'onboarding';
    const isDisclaimer = segments[0] === 'disclaimer';
    const isInviteRoute = segments[0] === 'invite';
    const isPublic =
      segments[0] === 'privacy-policy' || segments[0] === 'terms-of-service';

    // ===== FIRST-LAUNCH HEALTH DISCLAIMER GATE (v1.1.7) =====
    // Must run BEFORE the onboarding / auth checks below so the very
    // first thing a brand-new install sees is the medical disclaimer.
    // Once acknowledged (AsyncStorage flag), this branch never fires
    // again on this device.
    if (needsDisclaimer && !isDisclaimer && !isPublic) {
      logRootDecision('disclaimer_required', '/disclaimer', 'navigate');
      router.replace('/disclaimer');
      return;
    }
    // While ON the disclaimer screen, short-circuit the rest of the
    // gate.  This is the v1.1.8 fix for the strobe-loop: v1.1.7's
    // later branches (onboarding redirect, welcome redirect, etc.)
    // would fire one after another while we were on /disclaimer,
    // each kicking us off the disclaimer to another screen, which
    // then re-triggered the first branch above to put us back on
    // /disclaimer — visible to the user as rapid flashing between
    // screens.  Halting here keeps the user on /disclaimer until
    // setDisclaimerAck() flips needsDisclaimer to false, at which
    // point the gate falls through cleanly to onboarding/auth.
    if (isDisclaimer) {
      logRootDecision('disclaimer_screen_active', null, 'ready');
      setAppReadyForDeepLink(true);
      return;
    }
    // Which (auth) sub-route we're on, so we can let pin-login &
    // pin-setup live "inside" the authenticated session without
    // bouncing the user back to the dashboard.
    const authSubroute = ((segments as unknown as string[])[1] || '') as string;
    const onPinScreen = inAuthGroup && (authSubroute === 'pin-login' || authSubroute === 'pin-setup');

    // First-time users (not logged in, no onboarding flag) go to onboarding first.
    // EXCEPTION: invited users skip the slides — the person who sent the invite
    // already provided the human context that onboarding would give.  Mark
    // onboarding done silently and fall through so index.tsx can redirect to
    // the /invite/{token} screen.
    // Auth routes must remain stable once the user explicitly chooses Sign In
    // or Create Account. Without this exemption, pushing /(auth)/login while
    // needsOnboarding is true immediately replaces Login with /onboarding,
    // producing a visible horizontal push/replace loop.
    if (!user && needsOnboarding && !inAuthGroup && !isOnboarding && !isPublic) {
      let cancelled = false;
      (async () => {
        const stillNeeds = !(await isOnboardingDone());
        if (cancelled) return;
        if (stillNeeds) {
          const pendingToken = await getPendingInvite();
          if (cancelled) return;
          logStartupEvent({
            phase: 'pending_invite_load',
            event: 'pending_invite_load_completed',
            reason: 'onboarding_gate',
            outcome: pendingToken ? 'pending_invite_present' : 'no_pending_invite',
          });
          if (pendingToken) {
            // Invited path — skip slides, mark done, let the welcome-screen
            // pending-invite route take the user to /invite/{token}.
            await markOnboardingDone();
            if (cancelled) return;
            setNeedsOnboarding(false);
            if (pathname !== `/invite/${pendingToken.token}`) {
              logRootDecision('pending_invite_ready', `/invite/${pendingToken.token}`, 'navigate');
              router.replace(`/invite/${pendingToken.token}` as any);
            }
          } else {
            logRootDecision('unauthenticated_onboarding_required', '/onboarding', 'navigate');
            router.replace('/onboarding');
          }
        } else {
          setNeedsOnboarding(false);
        }
      })();
      return () => { cancelled = true; };
    }
    // A returning signed-out user can also cold-start from an invite after
    // onboarding has already been completed on this installation.
    // Once an invited user deliberately enters Sign In / OTP, keep that auth
    // route stable. The pending token remains persisted for verifyOtp(), so
    // redirecting back to the invite card only interrupts authentication.
    if (!user && coldStartInviteToken && !inAuthGroup && !isInviteRoute && !isPublic) {
      logRootDecision('cold_start_invite_ready', `/invite/${coldStartInviteToken}`, 'navigate');
      router.replace(`/invite/${coldStartInviteToken}` as any);
      return;
    }
    // DEFENSIVE: an unauthenticated user must NEVER be on a PIN
    // screen. PIN is per-account; without an account there's
    // nothing to set up or unlock. The v6.9 bug was a stale
    // Keychain token from a previous install briefly making
    // `user` truthy → RootNav routed to pin-setup → token
    // eventually got cleared by /auth/me failing → user back to
    // null but already stuck on pin-setup with no way out.
    //
    // Belt-and-suspenders fix: if we ever see user==null while
    // currently on a PIN screen, force-redirect to welcome.
    // (The pin-setup.tsx and pin-login.tsx screens have their
    // own identical guard, but doing it here too means we don't
    // depend on those screens having mounted yet.)
    if (!user && onPinScreen) {
      logRootDecision('unauthenticated_on_pin_screen', '/', 'navigate');
      router.replace('/');
      return;
    }
    if (!user && !inAuthGroup && !isWelcome && !isOnboarding && !isInviteRoute && !isPublic) {
      logRootDecision('unauthenticated_protected_route', '/', 'navigate');
      router.replace('/');
      return;
    }
    // OPTIONAL APP LOCK — the launch gate exists only for people who
    // deliberately enabled it in Me → Security. Re-check the preference and
    // saved PIN after a successful unlock so the route cannot loop.
    if (user && needsAppLockUnlock && !onPinScreen) {
      (async () => {
        const [enabled, hasPin] = await Promise.all([
          isAppLockEnabled(user.id),
          hasPinForUser(user.id),
        ]);
        if (enabled && hasPin && !isUnlockedNow(user.id)) {
          logRootDecision('app_lock_required', '/(auth)/pin-login', 'navigate');
          router.replace('/(auth)/pin-login');
        } else {
          setNeedsAppLockUnlock(false);
        }
      })();
      return;
    }

    // PERMISSIONS GATE — shown once per install after first authentication.
    // Re-verifies from storage on every run (same async-recheck pattern as
    // the pin-setup gate) so a successful completion on the permissions
    // screen is picked up as soon as segments change after its
    // router.replace('/(tabs)/dashboard').
    const onPermissionsScreen = inAuthGroup && authSubroute === 'permissions';
    if (user && needsPermissions && !needsAppLockUnlock && !onPermissionsScreen) {
      (async () => {
        const handled = await isPermissionsHandled();
        if (!handled) {
          logRootDecision('permissions_required', '/(auth)/permissions', 'navigate');
          router.replace('/(auth)/permissions');
        } else {
          setNeedsPermissions(false);
        }
      })();
      return;
    }

    if (user && !needsAppLockUnlock && !onPinScreen && !onPermissionsScreen && (inAuthGroup || isWelcome || isOnboarding)) {
      // Do not race a voluntary PIN setup/change screen. Otherwise an
      // authenticated session opens the app immediately by default.
      logRootDecision('authenticated_start_route', '/(tabs)/dashboard', 'navigate');
      router.replace('/(tabs)/dashboard');
      return;
    }
    // GATE CLEARED — let push.ts flush any queued notification
    // deep-link so the user lands directly on the acknowledge / alerts
    // screen they were intending to open. Runs both for fully-public
    // states (welcome / onboarding / public) and authenticated states
    // where no further redirect is needed, so taps from any state are
    // honoured once routing has settled.
    logRootDecision('all_navigation_gates_cleared', pathname || '/', 'ready');
    setAppReadyForDeepLink(true);
  }, [user, loading, segments, initialLinkChecked, coldStartInviteToken, onboardingChecked, needsOnboarding, appLockChecked, needsAppLockUnlock, disclaimerChecked, needsDisclaimer, permissionsChecked, needsPermissions]);

  // Part 7 — Battery optimization exemption prompt (Android only, post-onboarding).
  // Fired here — after the user has seen the full onboarding/permissions flow —
  // rather than 3 s after login, so they have context about why Kinnship needs
  // background access before being asked to open a system setting.
  // Conditions: authenticated + all onboarding / permissions gates cleared.
  useEffect(() => {
    if (!user || needsOnboarding || needsPermissions || Platform.OS !== 'android') return;
    (async () => {
      try {
        const already = await AsyncStorage.getItem(BATTERY_OPT_PROMPTED_KEY);
        if (already) return;
        await AsyncStorage.setItem(BATTERY_OPT_PROMPTED_KEY, '1');
        // Brief delay so the dashboard finishes painting before the Alert appears.
        await new Promise<void>((r) => setTimeout(r, 2000));
        Alert.alert(
          'Keep monitoring reliable',
          'To provide reliable location and battery monitoring, Android may need to allow Kinnship to run without battery optimization.\n\nTap "Open Settings," find Kinnship under Battery, and select "Unrestricted" or "Don\'t optimize."',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } catch (_e) {
        // Non-fatal — prompt is an enhancement, not required.
      }
    })();
  }, [user?.id, needsOnboarding, needsPermissions]);

  if (loading || !initialLinkChecked || !onboardingChecked || !disclaimerChecked || !permissionsChecked || (user && !appLockChecked)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="add-member" options={{ presentation: 'modal' }} />
      <Stack.Screen name="add-medication/[memberId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="add-routine/[memberId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="edit-medication/[reminderId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="check-in" />
      <Stack.Screen name="member/[id]" />
      <Stack.Screen name="privacy-policy" />
      <Stack.Screen name="terms-of-service" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="disclaimer" />
      <Stack.Screen name="(auth)/permissions" />
      <Stack.Screen name="upgrade" />
      <Stack.Screen name="sos-confirmation" />
      <Stack.Screen name="alert/[id]" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootNav />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
