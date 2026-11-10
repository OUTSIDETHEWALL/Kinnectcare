import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { clearReceivedEmailLink, emailLinkError, getReceivedEmailLink, parseEmailLink, redeemEmailLink, subscribeEmailLinks } from '../../src/emailLinks';
import { clearPendingInvite, markInviteConsumed, setPendingInvite } from '../../src/pendingInvite';
import { styles } from '../../src/EmailSignInScreen';

export default function EmailLinkCallback() {
  const url = Linking.useURL();
  const received = useSyncExternalStore(subscribeEmailLinks, getReceivedEmailLink, () => null);
  const router = useRouter();
  const { loading, user, acceptEmailSession } = useAuth();
  const [error, setError] = useState('');
  const [needsProfile, setNeedsProfile] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const attempted = useRef('');
  const parsed = received || parseEmailLink(url);
  const callbackKey = parsed ? `${parsed.state}:${parsed.token}` : '';

  async function finish(profile = false) {
    if (!parsed || active.current || loading) return;
    // A link must not silently switch an already authenticated installation.
    if (user) { setError('You are already signed in. Return to Kinnship, or sign out before using an email sign-in link.'); return; }
    active.current = true;
    setBusy(true); setError('');
    try {
      const data = await redeemEmailLink(parsed.token, parsed.state, profile ? { fullName: name, createFamily: true } : undefined);
      if (data.needs_profile) { setNeedsProfile(true); return; }
      if (data.invite_token) {
        if (data.invite_pending) await setPendingInvite(data.invite_token);
        else { await markInviteConsumed(data.invite_token); await clearPendingInvite(); }
      }
      await acceptEmailSession(data);
      clearReceivedEmailLink(parsed.token);
      router.replace(data.invite_pending ? `/invite/${data.invite_token}` as any : '/(tabs)/dashboard');
    } catch (e) { setError(emailLinkError(e)); }
    finally { active.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (loading || active.current || !callbackKey || attempted.current === callbackKey) return;
    attempted.current = callbackKey;
    setNeedsProfile(false);
    void finish();
    // Callback lifetime is keyed to the actual link, not changing auth state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbackKey, loading, busy]);

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.body}>
    <Text style={styles.title}>{needsProfile ? 'Welcome to Kinnship' : 'Opening Kinnship'}</Text>
    {(busy || loading) && <ActivityIndicator size="large" />}
    {!parsed && !loading && <Text style={styles.copy}>Open the secure link in your email on the phone where you requested it.</Text>}
    {needsProfile && <>
      <Text style={styles.copy}>There is no current account for this email. Enter your name to create a new family. Deleted history will not be restored. To join someone else’s family, open their invitation instead.</Text>
      <TextInput accessibilityLabel="Your name" placeholder="Your name" style={styles.input} value={name} onChangeText={setName} maxLength={80} />
      <TouchableOpacity disabled={busy || !name.trim()} style={styles.button} onPress={() => finish(true)}><Text style={styles.buttonText}>Create my family</Text></TouchableOpacity>
    </>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!!error && parsed && !needsProfile && !user && <TouchableOpacity disabled={busy} style={styles.button} onPress={() => finish()}><Text style={styles.buttonText}>Try again</Text></TouchableOpacity>}
    <TouchableOpacity style={styles.linkButton} onPress={() => router.replace(user ? '/(tabs)/dashboard' : '/(auth)/login')}><Text style={styles.link}>{user ? 'Return to Kinnship' : 'Request a new email link'}</Text></TouchableOpacity>
  </ScrollView></SafeAreaView>;
}
