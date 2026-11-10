import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Colors } from './theme';
import { emailLinkError, requestEmailLink } from './emailLinks';

export default function EmailSignInScreen({ createFamily = false }: { createFamily?: boolean }) {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string; invite_token?: string; family_name?: string; sent?: string }>();
  const inviteToken = String(params.invite_token || '');
  const [email, setEmail] = useState(String(params.email || ''));
  const [name, setName] = useState('');
  const [sent, setSent] = useState(params.sent === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(params.sent === '1' ? Date.now() + 60000 : 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!retryAfter) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);
  const remaining = Math.max(0, Math.ceil((retryAfter - now) / 1000));

  async function send() {
    if (busy || Date.now() < retryAfter) return;
    setError('');
    if (!inviteToken && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError('Please enter your email address.'); return;
    }
    if (createFamily && !inviteToken && !name.trim()) {
      setError('Please enter your name.'); return;
    }
    setBusy(true);
    try {
      await requestEmailLink({ email, fullName: name, inviteToken, createFamily: createFamily && !inviteToken });
      setSent(true);
      setRetryAfter(Date.now() + 60000);
    } catch (e) { setError(emailLinkError(e)); }
    finally { setBusy(false); }
  }
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    <TouchableOpacity accessibilityRole="button" onPress={() => router.replace('/')} style={styles.linkButton}><Text style={styles.link}>Back</Text></TouchableOpacity>
    <Text style={styles.title}>{sent ? 'Check your email' : inviteToken ? 'Join your family' : createFamily ? 'Create your family' : 'Welcome back'}</Text>
    <Text style={styles.copy}>{sent
      ? 'Tap “Continue to Kinnship” in your email on this phone. No code to enter. The link works for 15 minutes.'
      : inviteToken ? 'We’ll send a secure link to the email address your family invited. Tap it on this phone to continue.'
      : 'We’ll email you a secure sign-in link. No password or code to remember.'}</Text>
    {!sent && <>
      {createFamily && !inviteToken && <><Text style={styles.label}>Your name</Text><TextInput accessibilityLabel="Your name" style={styles.input} value={name} onChangeText={setName} maxLength={80} autoComplete="name" /></>}
      {!inviteToken && <><Text style={styles.label}>Email address</Text><TextInput accessibilityLabel="Email address" style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" /></>}
    </>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <TouchableOpacity accessibilityRole="button" disabled={busy || remaining > 0} style={styles.button} onPress={send}>
      {busy ? <ActivityIndicator color="white" /> : <Text style={styles.buttonText}>{remaining > 0 ? `Send again in ${remaining}s` : sent ? 'Send another email link' : 'Email me a secure link'}</Text>}
    </TouchableOpacity>
    {sent && <Text style={styles.copy}>If it hasn’t arrived, check spam and wait one minute before sending again. Open your most recent link. You can close Kinnship while you check your email.</Text>}
    <Text style={styles.copy}>An invitation does not turn on location sharing. You choose whether to share during setup.</Text>
    <TouchableOpacity onPress={() => router.push('/privacy-policy')} style={styles.linkButton}><Text style={styles.link}>Privacy Policy</Text></TouchableOpacity>
    <TouchableOpacity onPress={() => router.push('/terms-of-service')} style={styles.linkButton}><Text style={styles.link}>Terms of Service</Text></TouchableOpacity>
  </ScrollView></SafeAreaView>;
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  body: { padding: 24, paddingBottom: 48, maxWidth: 540, width: '100%', alignSelf: 'center' },
  title: { fontSize: 30, fontWeight: '800', color: Colors.primary, marginTop: 32, marginBottom: 16 },
  copy: { fontSize: 18, lineHeight: 28, color: Colors.textSecondary, marginVertical: 12 },
  label: { fontSize: 18, fontWeight: '600', color: Colors.textPrimary, marginTop: 20, marginBottom: 8 },
  input: { fontSize: 20, padding: 16, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, backgroundColor: Colors.surface, color: Colors.textPrimary },
  button: { minHeight: 60, backgroundColor: Colors.primary, borderRadius: 14, justifyContent: 'center', alignItems: 'center', padding: 16, marginVertical: 20 },
  buttonText: { fontSize: 20, color: '#fff', fontWeight: '700', textAlign: 'center' },
  error: { fontSize: 18, lineHeight: 26, color: '#A51D26', marginTop: 20 },
  link: { fontSize: 18, color: Colors.primary, textDecorationLine: 'underline' },
  linkButton: { paddingVertical: 14, minHeight: 48 },
});
