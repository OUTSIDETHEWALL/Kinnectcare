/**
 * permissions.tsx — first-launch permission onboarding screen.
 *
 * Shown once per install, immediately after a new user is authenticated
 * (gated by RootNav via needsPermissionsSetup).  Fires the OS location
 * and notification permission dialogs with emotional, family-focused
 * context immediately before each ask.
 *
 * Design principles (per founder directive):
 *   • Emotional copy — people care about family, not GPS
 *   • Never a dead end — if denied, explain consequences and offer
 *     "Open Settings" and "Continue Anyway" (no traps, no punishment)
 *   • 0 extra taps on the happy path — context shown during the family
 *     join loading state, OS dialogs fired automatically
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Platform, Linking, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Colors } from '../../src/theme';
import { markPermissionsHandled } from '../../src/permissionsStore';

type PermissionStage =
  | 'loading'           // brief pause — user reads context before OS dialog
  | 'location-context'  // show location explanation then auto-fire dialog
  | 'location-denied'   // user denied — offer Settings / Continue Anyway
  | 'notification-context' // show notifications explanation
  | 'notification-denied'
  | 'done';             // mark handled, route to dashboard

export default function Permissions() {
  const router = useRouter();
  const [stage, setStage] = useState<PermissionStage>('loading');
  const [locationGranted, setLocationGranted] = useState(false);
  const fired = useRef(false);

  // After a brief moment showing context, fire the OS dialogs in sequence.
  useEffect(() => {
    if (stage !== 'loading') return;
    const t = setTimeout(() => setStage('location-context'), 900);
    return () => clearTimeout(t);
  }, [stage]);

  // Auto-fire location dialog when we enter location-context stage.
  useEffect(() => {
    if (stage !== 'location-context') return;
    if (fired.current) return;
    fired.current = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          setLocationGranted(true);
          fired.current = false; // reset so notification effect can fire
          setStage('notification-context');
        } else {
          setStage('location-denied');
        }
      } catch (_e) {
        // Unexpected error — treat as denied so user isn't stuck.
        setStage('location-denied');
      }
    })();
  }, [stage]);

  const proceedToNotifications = () => {
    fired.current = false; // allow notification dialog to fire
    setStage('notification-context');
  };

  // Auto-fire notification dialog when we enter notification-context stage.
  useEffect(() => {
    if (stage !== 'notification-context') return;
    if (fired.current) return;
    fired.current = true;
    (async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status === 'granted') {
          finish();
        } else {
          setStage('notification-denied');
        }
      } catch (_e) {
        finish();
      }
    })();
  }, [stage]);

  const finish = async () => {
    await markPermissionsHandled();
    setStage('done');
    // RootNav re-reads permissionsHandled and routes to dashboard.
    router.replace('/(tabs)/dashboard');
  };

  const openSettings = () => {
    Linking.openSettings().catch(() => {
      Alert.alert(
        'Open Settings',
        'Go to Settings → Kinnship to change permissions.',
      );
    });
  };

  // ── Renderers ────────────────────────────────────────────────────────────

  if (stage === 'loading' || stage === 'done') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.emoji}>💚</Text>
          <Text style={styles.title}>Welcome to your family</Text>
          <Text style={styles.body}>
            Setting up Kinnship so your family can stay connected…
          </Text>
          <ActivityIndicator
            color={Colors.primary}
            size="large"
            style={{ marginTop: 32 }}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (stage === 'location-context') {
    // Shown for a split second before the OS dialog fires.
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.emoji}>📍</Text>
          <Text style={styles.title}>Let your family know you've arrived safely.</Text>
          <Text style={styles.body}>
            Your family can see you're safe — and reach you instantly
            if you ever need help.
          </Text>
          <ActivityIndicator
            color={Colors.primary}
            size="large"
            style={{ marginTop: 32 }}
          />
          <Text style={styles.hint}>
            Only shared with your family group.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (stage === 'location-denied') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.emoji}>📍</Text>
          <Text style={styles.title}>Your family won't be able to see you're safe.</Text>
          <Text style={styles.body}>
            Without location, your family can't tell when you've arrived
            somewhere — and SOS alerts won't be able to pinpoint your
            location in an emergency.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={openSettings}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={proceedToNotifications}
            activeOpacity={0.7}
          >
            <Text style={styles.secondaryBtnText}>Continue Anyway</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (stage === 'notification-context') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.emoji}>🔔</Text>
          <Text style={styles.title}>Be notified if someone you care about needs help.</Text>
          <Text style={styles.body}>
            You'll know the moment someone in your family needs you —
            SOS alerts, missed check-ins, and more.
          </Text>
          <ActivityIndicator
            color={Colors.primary}
            size="large"
            style={{ marginTop: 32 }}
          />
          <Text style={styles.hint}>
            You can adjust this in Settings at any time.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (stage === 'notification-denied') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.emoji}>🔔</Text>
          <Text style={styles.title}>You won't be notified if someone needs help.</Text>
          <Text style={styles.body}>
            Without notifications, SOS alerts and missed check-ins
            will be silent. You can turn them on in Settings at any time.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={openSettings}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={finish}
            activeOpacity={0.7}
          >
            <Text style={styles.secondaryBtnText}>Continue Anyway</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  center: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 72,
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: 14,
    lineHeight: 32,
  },
  body: {
    fontSize: 17,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 340,
  },
  hint: {
    marginTop: 20,
    fontSize: 12,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  primaryBtn: {
    marginTop: 32,
    width: '100%',
    maxWidth: 340,
    height: 58,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 3,
  },
  primaryBtnText: {
    color: Colors.surface,
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryBtn: {
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  secondaryBtnText: {
    fontSize: 15,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
});
