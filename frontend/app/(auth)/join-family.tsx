import React from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { styles } from '../../src/EmailSignInScreen';

export default function RecoverInvitation() {
  const router = useRouter();
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.body}>
    <Text style={styles.title}>Open your invitation email</Text>
    <Text style={styles.copy}>Tap “Accept Invitation” in the email your family sent you. Kinnship will remember which family you are joining. You do not need to type a code.</Text>
    <Text style={styles.copy}>Just installed Kinnship? Return to that email and tap the invitation again.</Text>
    <Text style={styles.copy}>Can’t find it, or has it expired? Ask your family to send you a new invitation.</Text>
    <TouchableOpacity style={styles.button} onPress={() => router.replace('/')}><Text style={styles.buttonText}>Back to Kinnship</Text></TouchableOpacity>
    <TouchableOpacity style={styles.linkButton} onPress={() => router.push('/(auth)/login')}><Text style={styles.link}>Already have an account? Sign in</Text></TouchableOpacity>
  </ScrollView></SafeAreaView>;
}
