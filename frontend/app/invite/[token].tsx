/**
 * Build #59 — Invitation Acceptance deep-link handler.
 *
 * Route: /invite/{token}
 * Scheme: kinnship://invite/{token} (see app.config.js)
 *
 * This screen is the single one-tap onboarding surface for invited
 * family members.  It handles four cases in order:
 *
 *   1. TOKEN INVALID / EXPIRED — big friendly error, ask them to
 *      request a new invite from their family.
 *
 *   2. ALREADY LOGGED IN as SOME OTHER family's user — call
 *      /family-group/join which will re-tag their data into the new
 *      family and pop them onto the dashboard.
 *
 *   3. ALREADY LOGGED IN with NO invite conflict — same call as (2),
 *      lands directly on dashboard.
 *
 *   4. NOT LOGGED IN — hand the token off to the signup flow via
 *      `router.push('/(auth)/signup', { invite_token, email })`.  The
 *      existing signup → OTP → verify-otp chain already knows how to
 *      consume `invite_token` and auto-join the target family group
 *      the moment the user's account is created.
 *
 * NO manual code typing is required in any of the four paths — this
 * screen exists so the caregiver-facing experience is literally
 * "open email, tap green button, done."
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Colors } from '../../src/theme';
import { api, joinFamilyGroup } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { setPendingInvite, clearPendingInvite } from '../../src/pendingInvite';

type VerifyResult = {
  valid: boolean;
  family_name?: string;
  inviter_name?: string | null;
  invitee_email?: string | null;
  code_type?: 'per-invite' | 'family-wide';
  reason?: string;
};

export default function InviteAcceptScreen() {
  const router = useRouter();
  const { token: rawToken } = useLocalSearchParams<{ token: string }>();
  const { user, loading: isLoading } = useAuth();
  const token = String(rawToken || '').trim().toUpperCase();

  const [verifying, setVerifying] = useState(true);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  // Step 1 — verify the token publicly (no auth required).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVerifying(true);
      if (!token) {
        setVerify({ valid: false, reason: 'Missing invitation code.' });
        setVerifying(false);
        return;
      }
      // Build #60 — persist the token BEFORE we do anything else, so
      // that even if the user closes this screen or the app crashes
      // between here and successful sign-in, AuthContext.verifyOtp
      // will still auto-consume it after they finish authenticating.
      // Belt-and-suspenders with the RootNav deep-link handler in
      // _layout.tsx: this catches the case where the invite/[token]
      // screen is entered from anywhere OTHER than a deep link
      // (e.g. an in-app router.push from the welcome screen).
      try { await setPendingInvite(token); } catch (_e) {}
      try {
        const r = await api.get(`/family-group/verify-invite/${token}`);
        if (!cancelled) setVerify(r.data);
      } catch (e: any) {
        if (!cancelled) setVerify({
          valid: false,
          reason:
            e?.response?.data?.reason
            || e?.response?.data?.detail
            || "We couldn't verify this invitation. Please try again.",
        });
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Step 2 — for unauthenticated users with a valid invite, auto-navigate
  // to the merged invite+account screen immediately.  No "Continue" tap
  // needed — the invite already provides the trust context; the person
  // who sent the link already explained what Kinnship is.
  useEffect(() => {
    if (verifying || !verify?.valid || user) return;
    // Unauthenticated + valid invite → go straight to signup with family
    // context embedded.  The signup screen in invite-flow mode shows the
    // family name and inviter prominently at the top.
    router.replace({
      pathname: '/(auth)/signup',
      params: {
        invite_token: token,
        email: verify.invitee_email || '',
        family_name: verify.family_name || '',
        inviter_name: verify.inviter_name || '',
      },
    } as any);
  }, [verifying, verify, user]);

  // For authenticated users who tap an invite link, keep the explicit
  // "Accept Invitation" button — they need to consciously confirm they're
  // joining this specific family group before we re-tag their data.
  const onAccept = async () => {
    if (!verify?.valid || !token) return;
    if (!user) {
      // Not logged in yet — hand token off to signup with prefilled
      // email so they don't have to type it.
      router.replace({
        pathname: '/(auth)/signup',
        params: {
          invite_token: token,
          email: verify.invitee_email || '',
        },
      } as any);
      return;
    }
    // Already logged in — call /family-group/join to re-tag their
    // data into this family group.
    setJoining(true);
    setJoinError(null);
    try {
      await joinFamilyGroup(token);
      // Build #60 — clear the pending-invite token now that the join
      // succeeded, so we don't try to re-consume it on a subsequent
      // launch.
      try { await clearPendingInvite(); } catch (_e) {}
      setJoined(true);
      // Land on dashboard once everything's synced.
      setTimeout(() => router.replace('/(tabs)/dashboard'), 1200);
    } catch (e: any) {
      setJoinError(
        e?.response?.data?.detail
        || e?.message
        || 'Could not accept invitation. Please try again.'
      );
    } finally {
      setJoining(false);
    }
  };

  // ---------- Renderers ----------

  if (verifying || isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Checking your invitation…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!verify?.valid) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <Text style={styles.emojiHero}>😕</Text>
          <Text style={styles.title}>Invitation not valid</Text>
          <Text style={styles.subtitle}>
            {verify?.reason || 'This invitation has expired, been used, or doesn\'t exist. Ask your family for a new invitation.'}
          </Text>
          <TouchableOpacity
            testID="invite-invalid-close"
            style={styles.secondaryBtn}
            onPress={() => router.replace('/')}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (joined) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <Text style={styles.emojiHero}>🎉</Text>
          <Text style={styles.title}>Welcome to the family!</Text>
          <Text style={styles.subtitle}>
            You've joined {verify.family_name || 'your family'}. Opening your dashboard…
          </Text>
          <ActivityIndicator style={{ marginTop: 12 }} color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // Valid invite — either "Accept" (logged in) or "Continue to sign-up".
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.centerBox}>
        <Text style={styles.emojiHero}>💚</Text>
        <Text style={styles.headline}>
          {verify.inviter_name
            ? `${verify.inviter_name} invited you`
            : "You're invited"}
        </Text>
        <Text style={styles.title}>
          to join {verify.family_name || 'their family'}
        </Text>
        <View style={styles.card}>
          <Text style={styles.cardHeader}>What is Kinnship?</Text>
          <Text style={styles.cardBody}>
            Kinnship keeps your family connected and safe with
            one-tap SOS, daily check-ins, medication reminders,
            and location sharing during emergencies.
          </Text>
        </View>

        {joinError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{joinError}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          testID="invite-accept-btn"
          onPress={onAccept}
          activeOpacity={0.85}
          disabled={joining}
          style={[styles.primaryBtn, joining && { opacity: 0.7 }]}
        >
          {joining
            ? <ActivityIndicator color={Colors.surface} />
            : <Text style={styles.primaryBtnText}>
                {user ? '✓  Accept Invitation' : 'Continue'}
              </Text>}
        </TouchableOpacity>

        <Text style={styles.footnote}>
          {user
            ? 'This will merge your account into this family. You can leave at any time from Me → Family.'
            : "We'll ask you to enter your name and email next. No account is created until you verify your email."}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  centerBox: {
    flex: 1, paddingHorizontal: 28, paddingVertical: 28,
    alignItems: 'center', justifyContent: 'center',
  },
  emojiHero: { fontSize: 56, marginBottom: 12 },
  loadingText: { fontSize: 14, color: Colors.textSecondary, marginTop: 16 },
  headline: {
    fontSize: 20, fontWeight: '700', color: Colors.textSecondary,
    textAlign: 'center', marginBottom: 6,
  },
  title: {
    fontSize: 26, fontWeight: '800', color: Colors.primary,
    textAlign: 'center', marginBottom: 20, lineHeight: 32,
  },
  subtitle: {
    fontSize: 15, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: 20,
  },
  card: {
    width: '100%', maxWidth: 380,
    padding: 20, borderRadius: 16,
    backgroundColor: '#F1F8E9', borderWidth: 1, borderColor: '#C5E1A5',
    marginTop: 8, marginBottom: 24,
  },
  cardHeader: { fontSize: 13, fontWeight: '800', color: Colors.primary, marginBottom: 8, letterSpacing: 0.4, textTransform: 'uppercase' },
  cardBody: { fontSize: 14, color: Colors.textPrimary, lineHeight: 21 },
  primaryBtn: {
    width: '100%', maxWidth: 380, height: 60,
    backgroundColor: Colors.primary, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.24, shadowRadius: 10, elevation: 4,
  },
  primaryBtnText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
  secondaryBtn: {
    marginTop: 24, paddingHorizontal: 28, paddingVertical: 14,
    borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
  },
  secondaryBtnText: { fontSize: 15, color: Colors.textSecondary, fontWeight: '700' },
  footnote: {
    marginTop: 16, fontSize: 12, color: Colors.textTertiary,
    textAlign: 'center', lineHeight: 18, maxWidth: 340,
  },
  errorBox: {
    marginTop: 12, padding: 14, borderRadius: 12,
    backgroundColor: '#fdecea', borderWidth: 1, borderColor: '#f5c6cb',
    maxWidth: 380, width: '100%',
  },
  errorText: { color: '#b00020', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
