import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import { hasPinForUser, markUnlocked, resetAttempts } from '../../src/pinAuth';
import { api as apiClient } from '../../src/api';

export default function Login() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // After a failed attempt we surface helpful diagnostics (length + a clear
  // hint that stale OS-level password autofill is the likely culprit) so the
  // user notices instantly when their phone silently filled an old password
  // instead of the current one.
  const [failHint, setFailHint] = useState<{ length: number } | null>(null);

  const onSubmit = async () => {
    // Trim whitespace on both fields before sending.  Mobile keyboards
    // (especially Gboard with autosuggest, and iOS password autofill)
    // routinely inject leading or trailing spaces.  The backend ALSO
    // trims as a safety net, but trimming here means the user sees a
    // working login on the FIRST attempt instead of a mystery 401.
    const emailTrim = (email || '').trim().toLowerCase();
    const passwordTrim = (password || '').trim();
    if (!emailTrim || !passwordTrim) {
      Alert.alert('Missing info', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(emailTrim, passwordTrim);
      setFailHint(null);
      // After successful email/password login decide where to go:
      //   • If a PIN is already saved for this user on THIS device →
      //     re-authenticating with a password is strictly stronger than
      //     the PIN, so we mark unlocked-for-this-session, reset any
      //     failed-PIN counter, and drop them on the dashboard.
      //   • If no PIN exists yet → route to the PIN setup screen.
      // /auth/me is the source of truth for the freshly-authenticated
      // user id (AuthContext's setUser may not have flushed yet).
      try {
        const me = await apiClient.get('/auth/me');
        const uid: string | undefined = me?.data?.id;
        if (uid) {
          await resetAttempts(uid);
          const has = await hasPinForUser(uid);
          if (has) {
            markUnlocked(uid);
            router.replace('/(tabs)/dashboard');
          } else {
            router.replace('/(auth)/pin-setup');
          }
          return;
        }
      } catch (_e) {}
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      // ROOT-CAUSE-DRIVEN FAILURE UX
      //
      // Backend logs proved the recurring login lockouts are NOT a backend
      // bug — they're stale iOS Keychain / Google Password Manager
      // autofill: when the user reset their password months ago, the OS
      // keeps suggesting the *old* saved password. The user thinks they
      // typed the right one but autofill silently overrode it
      // (pw_len=8 when the real password is 13 chars, etc.).
      //
      // Permanent fix:
      //   1. Auto-clear the password field so repeated submits don't loop
      //      with the same wrong autofill value.
      //   2. Auto-reveal the password field (eye → on) for 6 seconds so
      //      the user can VISUALLY confirm what their phone is filling.
      //   3. Show a friendly hint with the exact number of characters
      //      that was sent — users instantly notice "8? that's wrong,
      //      mine is 13" → they'll catch a stale autofill.
      setFailHint({ length: passwordTrim.length });
      setPassword('');
      setShowPassword(true);
      // Auto-hide the password again after a moment so we don't leave the
      // field permanently visible (privacy).
      setTimeout(() => setShowPassword(false), 6000);
      const serverMsg = e?.response?.data?.detail || 'Please check your credentials.';
      Alert.alert(
        'Sign in failed',
        `${serverMsg}\n\nYou entered ${passwordTrim.length} character${passwordTrim.length === 1 ? '' : 's'}. ` +
        `If that doesn't match your password length, your phone may have autofilled an older saved password. ` +
        `Tap the eye icon and re-type your password manually.`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity testID="login-back" onPress={() => router.back()} style={styles.back}>
            <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>

          <View style={styles.logoWrap}>
            <View style={styles.logoFrame}>
              <Image
                source={require('../../assets/images/kinnship-logo-dark.png')}
                style={styles.logoImage}
                resizeMode="contain"
                accessibilityLabel="Kinnship"
              />
            </View>
          </View>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to keep your family safe.</Text>

          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="login-email"
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={Colors.textTertiary}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              autoComplete="email"
              importantForAutofill="yes"
              returnKeyType="next"
            />
          </View>

          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                testID="login-password"
                style={styles.passwordInput}
                placeholder="••••••••"
                placeholderTextColor={Colors.textTertiary}
                value={password}
                onChangeText={(t) => { setPassword(t); if (failHint) setFailHint(null); }}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                autoComplete="current-password"
                importantForAutofill="yes"
                returnKeyType="go"
                onSubmitEditing={onSubmit}
              />
              <TouchableOpacity
                testID="login-password-toggle"
                style={styles.passwordEye}
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                <Icon
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={22}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
            {/* Persistent inline hint after a failed attempt — stays visible
                so the user can spot stale autofill (e.g. "8 chars" when
                their real password is 13 chars). Auto-clears on next typing. */}
            {failHint && (
              <Text testID="login-fail-hint" style={styles.failHint}>
                ⚠️ Last attempt used {failHint.length} character{failHint.length === 1 ? '' : 's'} — if that's wrong, your phone autofilled an old saved password. Tap 👁 and re-type manually.
              </Text>
            )}
          </View>

          <TouchableOpacity testID="login-submit" style={styles.cta} onPress={onSubmit} disabled={loading} activeOpacity={0.85}>
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Sign in</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            testID="login-to-forgot"
            onPress={() => router.push('/(auth)/forgot-password')}
            style={{ marginTop: 14, alignItems: 'center' }}
          >
            <Text style={[styles.link, { color: Colors.primary, fontWeight: '700' }]}>
              Forgot password?
            </Text>
          </TouchableOpacity>

          <TouchableOpacity testID="login-to-signup" onPress={() => router.replace('/(auth)/signup')} style={{ marginTop: 18, alignItems: 'center' }}>
            <Text style={styles.link}>New here? <Text style={{ fontWeight: '700', color: Colors.primary }}>Create an account</Text></Text>
          </TouchableOpacity>

          <View style={styles.legalRow}>
            <TouchableOpacity testID="login-to-privacy" onPress={() => router.push('/privacy-policy')}>
              <Text style={styles.legalLink}>Privacy Policy</Text>
            </TouchableOpacity>
            <Text style={styles.legalDot}>·</Text>
            <TouchableOpacity testID="login-to-terms" onPress={() => router.push('/terms-of-service')}>
              <Text style={styles.legalLink}>Terms of Service</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 52, height: 52, justifyContent: 'center' },
  logoWrap: { alignItems: 'center', marginTop: 8, marginBottom: 4 },
  logoFrame: {
    width: 160, height: 160, borderRadius: 80,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 12px 24px rgba(27,94,53,0.22)' as any,
  },
  logoImage: { width: 96, height: 96, borderRadius: 20 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 16, textAlign: 'center' },
  subtitle: { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', marginTop: 6 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  passwordInput: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    color: Colors.textPrimary,
  },
  passwordEye: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failHint: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.error,
    fontWeight: '600',
    paddingHorizontal: 4,
  },
  cta: {
    marginTop: 28, height: 58, borderRadius: 16, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  link: { color: Colors.textSecondary, fontSize: 15 },
  legalRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    marginTop: 28, gap: 8,
  },
  legalLink: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600', textDecorationLine: 'underline' },
  legalDot: { fontSize: 13, color: Colors.textTertiary },
});
