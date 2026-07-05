import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert as RNAlert, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { Colors } from '../../src/theme';
import { api } from '../../src/api';

/**
 * Full-screen acknowledge panel for elderly users.
 *
 * Designed per Charles' accessibility brief:
 *   • Large bold title (44pt) explaining the alert
 *   • Massive solid GREEN "✅ ACKNOWLEDGE" button (90pt tall, full-width)
 *   • High contrast, no transparency — impossible to miss
 *   • One-button focus: tapping ACKNOWLEDGE marks the med as taken,
 *     dismisses the notification, and returns to the dashboard
 *   • Secondary "Snooze 10m" available as a smaller text-style button
 *
 * Entry points:
 *   • Notification body tap (push handler in app/_layout.tsx now routes
 *     med/routine self-due notifications here)
 *   • Could also be triggered from the Alerts tab in a future update
 *
 * URL params: type (medication|routine), reminder_id, title, dosage, member_name
 */
export default function NotificationActionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    type?: string;
    reminder_id?: string;
    title?: string;
    dosage?: string;
    member_name?: string;
    stage?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const isRoutine = params.type === 'routine';
  const isFamilyAlert = params.stage === 'family_alert';

  const headerTitle = isFamilyAlert
    ? `${params.member_name || 'Your loved one'} hasn't confirmed`
    : isRoutine
      ? `Time for ${params.title || 'your routine'}`
      : `Time to take your ${params.title || 'medication'}`;

  const subtitle = isFamilyAlert
    ? `They haven't tapped "I Took It" yet for their ${params.title || 'medication'}. ` +
      `Please check on them.`
    : isRoutine
      ? (params.dosage || 'Tap acknowledge when you\'re done.')
      : (params.dosage
          ? `${params.dosage}\n\nTap ACKNOWLEDGE below once you've taken it.`
          : 'Tap ACKNOWLEDGE below once you\'ve taken it.');

  // When the user lands on this screen via notification tap, also
  // dismiss any sticky/active notifications for the SAME reminder
  // so the tray doesn't keep nagging them while they're actively
  // dealing with it. (Not strictly needed for the loop fix — the
  // consumedNotificationIds dedupe in push.ts handles that — but
  // good UX hygiene either way.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const presented = await Notifications.getPresentedNotificationsAsync();
        if (cancelled) return;
        for (const n of presented) {
          const nData: any = n.request?.content?.data || {};
          if (
            params.reminder_id &&
            nData.reminder_id === params.reminder_id
          ) {
            try {
              await Notifications.dismissNotificationAsync(n.request.identifier);
            } catch (_e) {}
          }
        }
      } catch (_e) {}
    })();
    return () => { cancelled = true; };
  }, [params.reminder_id]);

  const acknowledge = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (params.reminder_id) {
        await api.post(`/reminders/${params.reminder_id}/mark`, {
          status: 'taken',
        });
      }
      // Also clear ALL presented notifications so the sticky
      // follow-up doesn't keep haunting the tray after acknowledge.
      try {
        await Notifications.dismissAllNotificationsAsync();
      } catch (_e) {}
      setDone(true);
      setTimeout(() => router.replace('/(tabs)/dashboard'), 1200);
    } catch (e: any) {
      RNAlert.alert(
        'Could not acknowledge',
        'Please try again. Your network may be offline.',
        [{ text: 'OK' }],
      );
    } finally {
      setLoading(false);
    }
  };

  // Auto-close after acknowledgement for a moment to show success.
  useEffect(() => {
    // empty
  }, []);

  const headerEmoji = isFamilyAlert
    ? '⚠️'
    : isRoutine
      ? '🌿'
      : '💊';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.container}>
        {/* Big header emoji + title */}
        <View style={styles.headerBlock}>
          <Text style={styles.emoji}>{headerEmoji}</Text>
          <Text style={styles.title} accessibilityRole="header">
            {headerTitle}
          </Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>

        <View style={{ flex: 1 }} />

        {/* Solid green acknowledge button — the only thing on the screen
            you can really miss. Massive touch target (90pt high). */}
        {done ? (
          <View style={[styles.ackButton, styles.ackButtonDone]}>
            <Text
              style={styles.ackButtonText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              ✅  Acknowledged
            </Text>
          </View>
        ) : (
          <TouchableOpacity
            testID="notif-acknowledge"
            style={styles.ackButton}
            onPress={acknowledge}
            disabled={loading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Acknowledge medication taken"
          >
            {loading ? (
              <ActivityIndicator color={Colors.surface} size="large" />
            ) : (
              <Text
                style={styles.ackButtonText}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
              >
                {isFamilyAlert ? '✅  CHECKED ON THEM' : '✅  ACKNOWLEDGE'}
              </Text>
            )}
          </TouchableOpacity>
        )}

        {/* Secondary action — snooze (medications only, not family alerts) */}
        {!isFamilyAlert && !done && (
          <TouchableOpacity
            testID="notif-dismiss"
            style={styles.dismissButton}
            onPress={() => router.replace('/(tabs)/dashboard')}
            activeOpacity={0.7}
          >
            <Text style={styles.dismissText}>I'll do it later</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  container: { flex: 1, padding: 24, paddingTop: 32 },
  headerBlock: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  emoji: { fontSize: 92, marginBottom: 12 },
  title: {
    fontSize: 36,
    lineHeight: 42,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: 20,
  },
  subtitle: {
    fontSize: 20,
    lineHeight: 28,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  ackButton: {
    height: 96,
    backgroundColor: '#16A34A',   // Bright solid green — no transparency.
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginHorizontal: 8,
    marginBottom: 16,
    ...Platform.select({
      android: { elevation: 8 },
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 10 },
    }),
  },
  ackButtonDone: { backgroundColor: '#15803D' },
  ackButtonText: {
    color: '#FFFFFF',
    // v6.7 — hard-reduced baseline 20 → 17pt with negative letter-spacing.
    // RN Android has a long-standing quirk where adjustsFontSizeToFit is
    // unreliable when combined with numberOfLines={1} + flex parents — text
    // sometimes wraps to two lines instead of shrinking. By making 17pt
    // unconditionally fit on a 320dp screen (≈ 19 chars × ~9px ≈ 170px,
    // well under the ~280px usable width after paddings), we don't have
    // to rely on the runtime shrinker at all. Still bold + high contrast.
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  dismissButton: {
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
    marginBottom: 8,
  },
  dismissText: {
    fontSize: 17,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
});
