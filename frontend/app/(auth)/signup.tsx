/**
 * signup.tsx — passwordless email-OTP sign-up.
 *
 * Collects name + email + optional invite code, then sends a 6-digit
 * verification code to the email. The account is actually CREATED
 * on the backend only after the user successfully types the OTP on
 * the next screen — so an unverified email can never become an
 * account. (See /api/auth/verify-otp.)
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';

export default function Signup() {
  const router = useRouter();
  const { requestOtp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    const nameTrim = (name || '').trim();
    const emailTrim = (email || '').trim().toLowerCase();
    if (!nameTrim) {
      Alert.alert('Name needed', 'Please enter your name so your family knows who you are.');
      return;
    }
    if (!emailTrim || !/^\S+@\S+\.\S+$/.test(emailTrim)) {
      Alert.alert('Email needed', "Please enter a valid email address — we'll send your verification code there.");
      return;
    }
    setLoading(true);
    try {
      await requestOtp({
        email: emailTrim,
        purpose: 'signup',
        fullName: nameTrim,
        inviteCode: inviteCode.trim() || undefined,
      });
      router.push({
        pathname: '/(auth)/otp-verify',
        params: {
          email: emailTrim,
          purpose: 'signup',
          fullName: nameTrim,
          inviteCode: inviteCode.trim() || '',
        },
      } as any);
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail || '';
      if (status === 410) {
        Alert.alert('Update required', detail);
      } else if (status === 429) {
        Alert.alert('Please wait', detail || 'You requested a code recently. Try again in a few seconds.');
      } else {
        Alert.alert('Could not create account', detail || 'Please check your connection and try again.');
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
          <TouchableOpacity testID="signup-back" onPress={() => router.back()} style={styles.back}>
            <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>
            No password to remember — we'll email you a 6-digit code instead.
          </Text>

          <Field
            label="Full name"
            value={name}
            onChangeText={setName}
            placeholder="Jane Smith"
            testID="signup-name"
            autoCapitalize="words"
          />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="emailAddress"
            autoComplete="email"
            testID="signup-email"
          />
          <Field
            label="Family invite code (optional)"
            value={inviteCode}
            onChangeText={(v: string) => setInviteCode(v.toUpperCase())}
            placeholder="KINN-XXXXXX"
            autoCapitalize="characters"
            testID="signup-invite-code"
          />
          {inviteCode.trim() ? (
            <Text style={styles.inviteHint}>
              👨‍👩‍👧 You'll join an existing family and see their members & alerts immediately.
            </Text>
          ) : null}

          <TouchableOpacity
            testID="signup-submit"
            style={styles.cta}
            onPress={onSubmit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color={Colors.surface} />
              : <Text style={styles.ctaText}>Email me a code</Text>}
          </TouchableOpacity>

          <Text style={styles.agreement}>
            By creating an account, you agree to our{' '}
            <Text testID="signup-to-terms" style={styles.agreementLink} onPress={() => router.push('/terms-of-service')}>
              Terms of Service
            </Text>{' '}
            and{' '}
            <Text testID="signup-to-privacy" style={styles.agreementLink} onPress={() => router.push('/privacy-policy')}>
              Privacy Policy
            </Text>
            .
          </Text>

          <TouchableOpacity
            testID="signup-to-login"
            onPress={() => router.replace('/(auth)/login')}
            style={{ marginTop: 18, alignItems: 'center' }}
          >
            <Text style={styles.link}>
              Already have an account? <Text style={{ fontWeight: '700', color: Colors.primary }}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field(props: any) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        {...props}
        style={styles.input}
        placeholderTextColor={Colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 52, height: 52, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 8 },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: 6, marginBottom: 8, lineHeight: 22 },
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
  agreement: {
    fontSize: 12, color: Colors.textTertiary, textAlign: 'center',
    marginTop: 14, paddingHorizontal: 6, lineHeight: 18,
  },
  agreementLink: { color: Colors.primary, fontWeight: '700', textDecorationLine: 'underline' },
  inviteHint: { fontSize: 12, color: Colors.success, marginTop: 8, lineHeight: 18 },
});
