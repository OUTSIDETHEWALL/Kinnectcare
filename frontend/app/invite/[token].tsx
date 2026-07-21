/**
 * Invite acceptance deep-link handler.
 *
 * Route: /invite/{token}
 * Scheme: kinnship://invite/{token}
 *
 * Zero-friction onboarding sprint:
 *   - One screen, one decision, one primary action.
 *   - The confirmation card is shown to ALL users — authenticated or not.
 *     No one is redirected without a conscious tap.
 *   - Unauthenticated → "Join Family" navigates to signup with family
 *     context pre-filled. verifyOtp() auto-joins after account creation.
 *   - Authenticated → "Join Family" calls /family-group/join directly.
 *   - Already a member → distinct friendly card; no error language.
 *   - "Decline" clears the pending invite and returns to welcome.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
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
  const [alreadyMember, setAlreadyMember] = useState(false);

  // Verify the token. Persist it first so auth flows can resume
  // the invite even if this screen is closed mid-flow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVerifying(true);
      if (!token) {
        setVerify({ valid: false, reason: 'Missing invitation code.' });
        setVerifying(false);
        return;
      }
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

  const familyName = verify?.family_name || 'their family';
  const inviterName = verify?.inviter_name;

  const onJoin = async () => {
    if (!verify?.valid || !token) return;

    if (!user) {
      // Not signed in — hand the token to signup. verifyOtp() will
      // auto-join after the account is created or the user signs in.
      router.replace({
        pathname: '/(auth)/signup',
        params: {
          invite_token: token,
          email: verify.invitee_email || '',
          family_name: verify.family_name || '',
          inviter_name: verify.inviter_name || '',
        },
      } as any);
      return;
    }

    // Signed in — join directly.
    setJoining(true);
    setJoinError(null);
    try {
      const result = await joinFamilyGroup(token);
      try { await clearPendingInvite(); } catch (_e) {}
      if (result.already_member) {
        setAlreadyMember(true);
      } else {
        setJoined(true);
        setTimeout(() => router.replace('/(tabs)/dashboard'), 1200);
      }
    } catch (e: any) {
      setJoinError(
        e?.response?.data?.detail
        || e?.message
        || 'Could not accept invitation. Please try again.',
      );
    } finally {
      setJoining(false);
    }
  };

  const onDecline = async () => {
    try { await clearPendingInvite(); } catch (_e) {}
    router.replace('/');
  };

  // ── Loading ──────────────────────────────────────────────────────
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

  // ── Already a member ─────────────────────────────────────────────
  if (alreadyMember) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <Text style={styles.emojiHero}>💚</Text>
          <Text style={styles.title}>
            You're already part of {familyName}
          </Text>
          <TouchableOpacity
            testID="already-member-open-btn"
            style={styles.primaryBtn}
            onPress={() => router.replace('/(tabs)/dashboard')}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Open Family</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Success (just joined) ─────────────────────────────────────────
  if (joined) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <Text style={styles.emojiHero}>🎉</Text>
          <Text style={styles.title}>Welcome to the family!</Text>
          <Text style={styles.subtitle}>
            Opening {familyName}…
          </Text>
          <ActivityIndicator style={{ marginTop: 12 }} color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // ── Invalid / expired invite ──────────────────────────────────────
  if (!verify?.valid) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.centerBox}>
          <Text style={styles.emojiHero}>😕</Text>
          <Text style={styles.title}>This invitation is no longer active</Text>
          <Text style={styles.subtitle}>
            Ask the person who invited you to send a new one. It only takes
            a moment.
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

  // ── Confirmation card ─────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.centerBox}>
        <Text style={styles.emojiHero}>💚</Text>

        <Text style={styles.inviterLine}>
          {inviterName ? `${inviterName} invited you` : "You're invited"}
        </Text>
        <Text style={styles.title}>
          to join {familyName}
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
          testID="invite-join-btn"
          onPress={onJoin}
          activeOpacity={0.85}
          disabled={joining}
          style={[styles.primaryBtn, joining && { opacity: 0.7 }]}
        >
          {joining
            ? <ActivityIndicator color={Colors.surface} />
            : <Text style={styles.primaryBtnText}>Join Family</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          testID="invite-decline-btn"
          onPress={onDecline}
          activeOpacity={0.7}
          style={styles.declineBtn}
        >
          <Text style={styles.declineBtnText}>Decline</Text>
        </TouchableOpacity>
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
  inviterLine: {
    fontSize: 18, fontWeight: '600', color: Colors.textSecondary,
    textAlign: 'center', marginBottom: 6,
  },
  title: {
    fontSize: 26, fontWeight: '800', color: Colors.primary,
    textAlign: 'center', marginBottom: 20, lineHeight: 32,
  },
  subtitle: {
    fontSize: 15, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: 28, paddingHorizontal: 8,
  },
  card: {
    width: '100%', maxWidth: 380,
    padding: 20, borderRadius: 16,
    backgroundColor: '#F1F8E9', borderWidth: 1, borderColor: '#C5E1A5',
    marginBottom: 24,
  },
  cardHeader: {
    fontSize: 13, fontWeight: '800', color: Colors.primary,
    marginBottom: 8, letterSpacing: 0.4, textTransform: 'uppercase',
  },
  cardBody: { fontSize: 14, color: Colors.textPrimary, lineHeight: 21 },
  primaryBtn: {
    width: '100%', maxWidth: 380, height: 60,
    backgroundColor: Colors.primary, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.24, shadowRadius: 10, elevation: 4,
  },
  primaryBtnText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
  declineBtn: { marginTop: 18, paddingVertical: 12, paddingHorizontal: 24 },
  declineBtnText: { fontSize: 15, color: Colors.textTertiary, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 24, paddingHorizontal: 28, paddingVertical: 14,
    borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
  },
  secondaryBtnText: { fontSize: 15, color: Colors.textSecondary, fontWeight: '700' },
  errorBox: {
    marginTop: 12, marginBottom: 4, padding: 14, borderRadius: 12,
    backgroundColor: '#fdecea', borderWidth: 1, borderColor: '#f5c6cb',
    maxWidth: 380, width: '100%',
  },
  errorText: { color: '#b00020', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
