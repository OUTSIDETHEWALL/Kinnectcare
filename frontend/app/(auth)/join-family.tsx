/**
 * Pre-account invite onboarding (Fix #2 of v1.2 beta).
 *
 * Flow: Welcome → "Join a Family" → THIS SCREEN → verify invite →
 *       Sign up (with invite_token attached) → automatic join.
 *
 * The user types their INV-XXXXXX (or KINN-XXXXXX) code, we hit the
 * public /api/family-group/verify-invite/{code} endpoint, and on
 * success we forward to the signup screen with `invite_token` and
 * an optional pre-filled `email` (per-recipient INV codes carry the
 * email they were issued to).
 *
 * Why this lives in (auth) and not at the root: it's a step in the
 * auth flow — the user is moving towards an authenticated session
 * via an invite-attached signup.
 */
import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert as RNAlert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api } from '../../src/api';

type VerifyResult = {
  valid: boolean;
  reason?: string;
  family_name?: string;
  inviter_name?: string | null;
  invitee_email?: string | null;
  code_type?: 'per-invite' | 'family-wide';
};

export default function JoinFamilyByCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [preview, setPreview] = useState<VerifyResult | null>(null);

  const normalized = code.trim().toUpperCase();
  const looksValid =
    /^INV-[A-Z0-9]{4,}$/.test(normalized) ||
    /^KINN-[A-Z0-9]{4,}$/.test(normalized);

  async function verify() {
    if (!looksValid || verifying) return;
    setVerifying(true);
    setPreview(null);
    try {
      const res = await api.get(`/family-group/verify-invite/${normalized}`);
      const data: VerifyResult = res.data || { valid: false };
      setPreview(data);
      if (!data.valid) {
        RNAlert.alert(
          'Invite not valid',
          data.reason ||
            'This code was not recognized. Double-check it with whoever invited you.',
        );
      }
    } catch (_e: any) {
      RNAlert.alert(
        'Connection error',
        'Could not reach Kinnship. Check your internet connection and try again.',
      );
    } finally {
      setVerifying(false);
    }
  }

  function proceedToSignup() {
    if (!preview?.valid) return;
    // Forward the code + (optional) pre-filled email into signup.  The
    // signup screen reads them from URL params and includes
    // `invite_token` in the OTP verify payload so the backend
    // auto-joins the family on first successful login.
    router.replace({
      pathname: '/(auth)/signup',
      params: {
        invite_token: normalized,
        email: preview.invitee_email || '',
        family_name: preview.family_name || '',
        inviter_name: preview.inviter_name || '',
      },
    } as any);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <TouchableOpacity
            onPress={() => router.replace('/')}
            style={styles.backBtn}
            accessibilityRole="button"
          >
            <Icon name="chevron-back" size={26} color={Colors.text} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

          <View style={styles.iconBubble}>
            <Icon name="people" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Join your family</Text>
          <Text style={styles.subtitle}>
            Enter the invite code someone in your family sent you.{'\n'}
            It usually starts with INV- or KINN-.
          </Text>

          <Text style={styles.label}>Invite code</Text>
          <TextInput
            value={code}
            onChangeText={(t) => {
              setCode(t);
              setPreview(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            placeholder="INV-XXXXXX"
            placeholderTextColor={Colors.textSecondary}
            style={styles.input}
            returnKeyType="done"
            onSubmitEditing={verify}
            testID="invite-code-input"
          />

          {preview?.valid ? (
            <View style={styles.previewCard}>
              <Text style={styles.previewLabel}>You'll be joining</Text>
              <Text style={styles.previewFamily}>{preview.family_name}</Text>
              {!!preview.inviter_name && (
                <Text style={styles.previewBy}>
                  Invited by {preview.inviter_name}
                </Text>
              )}
            </View>
          ) : null}

          {preview?.valid ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={proceedToSignup}
              testID="continue-to-signup-btn"
            >
              <Text style={styles.primaryBtnText}>Continue</Text>
              <Icon name="arrow-forward" size={20} color={Colors.surface} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (!looksValid || verifying) && styles.btnDisabled,
              ]}
              onPress={verify}
              disabled={!looksValid || verifying}
              testID="verify-invite-btn"
            >
              {verifying ? (
                <ActivityIndicator color={Colors.surface} />
              ) : (
                <Text style={styles.primaryBtnText}>Verify Code</Text>
              )}
            </TouchableOpacity>
          )}

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            onPress={() => router.replace('/(auth)/login')}
            style={styles.loginLink}
          >
            <Text style={styles.loginLinkText}>
              Already have an account?{' '}
              <Text style={{ fontWeight: '700' }}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingRight: 12,
  },
  backText: { fontSize: 17, color: Colors.text, marginLeft: 2 },
  iconBubble: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 22,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginTop: 28,
    marginBottom: 8,
  },
  input: {
    height: 60,
    borderRadius: 14,
    paddingHorizontal: 18,
    backgroundColor: Colors.surface,
    color: Colors.text,
    fontSize: 20,
    letterSpacing: 2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  previewCard: {
    marginTop: 18,
    padding: 18,
    borderRadius: 14,
    backgroundColor: Colors.tertiary,
    alignItems: 'center',
  },
  previewLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  previewFamily: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.primary,
    marginTop: 6,
  },
  previewBy: { fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  primaryBtn: {
    marginTop: 18,
    height: 60,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryBtnText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
  loginLink: { alignItems: 'center', marginTop: 24 },
  loginLinkText: { fontSize: 14, color: Colors.textSecondary },
});
