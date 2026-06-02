/**
 * login.tsx — passwordless email-OTP sign-in.
 *
 * As of v6.11 there is no password field anywhere in Kinnship. The
 * sign-in flow is:
 *
 *   1. User enters their email here.
 *   2. We call requestOtp({ purpose: 'login' }) — backend sends a
 *      6-digit code to their inbox.
 *   3. We push /(auth)/otp-verify?email=...&purpose=login where the
 *      user types the 6 digits to complete sign-in.
 *
 * No autofill hacks, no password reveal toggle, no failed-attempt
 * length hints. The entire class of "stale autofill locked me out"
 * bugs is gone by design.
 */
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

export default function Login() {
  const router = useRouter();
  const { requestOtp } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    const emailTrim = (email || '').trim().toLowerCase();
    if (!emailTrim || !/^\S+@\S+\.\S+$/.test(emailTrim)) {
      Alert.alert('Email needed', 'Please enter the email address you signed up with.');
      return;
    }
    setLoading(true);
    try {
      await requestOtp({ email: emailTrim, purpose: 'login' });
      router.push({
        pathname: '/(auth)/otp-verify',
        params: { email: emailTrim, purpose: 'login' },
      } as any);
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail || '';
      const code = e?.code || '';
      if (status === 410) {
        Alert.alert('Update required', detail);
      } else if (status === 429) {
        Alert.alert('Please wait', detail || 'You requested a code recently. Try again in a few seconds.');
      } else if (code === 'ECONNABORTED' || /timeout/i.test(String(e?.message || ''))) {
        // The OTP endpoint now returns in <300ms (SMTP runs in the
        // background) so a timeout here generally means a real network
        // issue, not a slow Gmail handshake.
        Alert.alert(
          'Network timeout',
          "We couldn't reach the Kinnship servers. Please check your Wi-Fi or cellular signal and try again.",
        );
      } else if (!status) {
        // No response at all → network/DNS/TLS failure.
        Alert.alert(
          'No connection',
          `We couldn't reach the Kinnship servers (${e?.message || 'unknown error'}). Please check your connection and try again.`,
        );
      } else {
        // Backend responded with an unexpected status — surface it
        // verbatim so support can diagnose at a glance.
        Alert.alert('Could not send code', detail || `Server returned ${status}. Please try again.`);
      }
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
          <Text style={styles.subtitle}>
            We'll email you a 6-digit code — no password needed.
          </Text>

          <View style={{ marginTop: 24 }}>
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
              textContentType="emailAddress"
              autoComplete="email"
              importantForAutofill="yes"
              returnKeyType="go"
              onSubmitEditing={onSubmit}
              autoFocus
            />
          </View>

          <TouchableOpacity
            testID="login-submit"
            style={styles.cta}
            onPress={onSubmit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color={Colors.surface} />
              : <Text style={styles.ctaText}>Email me a code</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            testID="login-to-signup"
            onPress={() => router.replace('/(auth)/signup')}
            style={{ marginTop: 18, alignItems: 'center' }}
          >
            <Text style={styles.link}>
              New here? <Text style={{ fontWeight: '700', color: Colors.primary }}>Create an account</Text>
            </Text>
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
  subtitle: { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 22 },
  label: {
    fontSize: 13, fontWeight: '700', color: Colors.textSecondary,
    marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
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
