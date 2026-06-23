/**
 * Quiet Hours settings screen (v1.3.3).
 *
 * Lets the user define a daily window during which non-emergency
 * notifications are suppressed.  SOS, Fall Detection, and the silent
 * location-refresh pings ALWAYS bypass.
 *
 * Architecture:
 *   • Backend is the source of truth.  When the user submits, we
 *     PUT /api/me/preferences with the new shape — backend stores +
 *     gates push_to_user() against it for every push.
 *   • The local "Currently active" badge is a UX-only signal computed
 *     against the device clock; backend interprets the window in the
 *     user's IANA timezone (also server-side).  They'll agree as long
 *     as user.timezone matches the device — already the case after
 *     onboarding's timezone sync.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { TimePicker12 } from '../src/TimePicker12';
import {
  getPreferences,
  updatePreferences,
  isCurrentlyInWindow,
  formatHHMM12,
  type QuietHoursPreference,
} from '../src/preferences';

export default function QuietHoursScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qh, setQh] = useState<QuietHoursPreference>({
    enabled: false,
    start: '22:00',
    end: '07:00',
  });
  const [dirty, setDirty] = useState(false);
  const [tickNow, setTickNow] = useState(0);   // forces re-render of "active" badge each minute

  useEffect(() => {
    (async () => {
      try {
        const p = await getPreferences();
        setQh(p.quiet_hours);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTickNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const onChange = (patch: Partial<QuietHoursPreference>) => {
    setQh((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const onSave = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const next = await updatePreferences({ quiet_hours: qh });
      setQh(next.quiet_hours);
      setDirty(false);
      Alert.alert(
        '✅ Quiet Hours saved',
        next.quiet_hours.enabled
          ? `Non-emergency notifications will be silenced from ${formatHHMM12(next.quiet_hours.start)} to ${formatHHMM12(next.quiet_hours.end)} daily.\n\nSOS and Fall Detection always ring through.`
          : 'Quiet Hours disabled. All notifications will deliver normally.',
      );
    } catch (e: any) {
      Alert.alert('Could not save', e?.message || 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  }, [dirty, qh]);

  // Use tickNow to ensure re-render every 30 s for active-badge accuracy.
  const isActive = isCurrentlyInWindow(qh) && tickNow >= 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="quiet-hours-back"
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Icon name="chevron-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Quiet Hours</Text>
        <View style={{ width: 28 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Status badge */}
          {qh.enabled ? (
            <View style={[styles.statusBadge, isActive ? styles.statusActive : styles.statusInactive]} testID="quiet-hours-status">
              <Text style={styles.statusEmoji}>{isActive ? '🌙' : '☀️'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.statusTitle}>
                  {isActive ? 'Quiet Hours active' : 'Quiet Hours scheduled'}
                </Text>
                <Text style={styles.statusBody}>
                  {isActive
                    ? `Reminders muted until ${formatHHMM12(qh.end)}. SOS and Fall Detection still alert.`
                    : `Will mute reminders from ${formatHHMM12(qh.start)} to ${formatHHMM12(qh.end)} daily.`}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Enable toggle */}
          <View style={styles.card}>
            <View style={styles.cardRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={styles.cardTitle}>Enable Quiet Hours</Text>
                <Text style={styles.cardSub}>
                  Silence non-emergency notifications during a daily window.
                </Text>
              </View>
              <Switch
                testID="quiet-hours-enable"
                value={qh.enabled}
                onValueChange={(v) => onChange({ enabled: v })}
                trackColor={{ false: Colors.border, true: Colors.primary }}
                thumbColor={Colors.surface}
              />
            </View>
          </View>

          {/* Time pickers */}
          <View style={[styles.card, !qh.enabled && { opacity: 0.45 }]} pointerEvents={qh.enabled ? 'auto' : 'none'}>
            <Text style={styles.sectionLabel}>Start time</Text>
            <Text style={styles.sectionHelp}>When silence begins each day.</Text>
            <TimePicker12
              testIDPrefix="quiet-hours-start"
              value={qh.start}
              onChange={(v: string) => onChange({ start: v })}
            />

            <View style={{ height: 14 }} />

            <Text style={styles.sectionLabel}>End time</Text>
            <Text style={styles.sectionHelp}>
              When the window ends.  Times can cross midnight (e.g. 10:00 PM → 7:00 AM).
            </Text>
            <TimePicker12
              testIDPrefix="quiet-hours-end"
              value={qh.end}
              onChange={(v: string) => onChange({ end: v })}
            />
          </View>

          {/* Always-on bypass list */}
          <View style={styles.bypassCard}>
            <Text style={styles.bypassTitle}>🚨 Always alerts (cannot be silenced)</Text>
            <View style={styles.bypassRow}><Text style={styles.bypassDot}>•</Text><Text style={styles.bypassText}>SOS button presses from any family member</Text></View>
            <View style={styles.bypassRow}><Text style={styles.bypassDot}>•</Text><Text style={styles.bypassText}>Fall Detection countdown expirations</Text></View>
            <View style={styles.bypassRow}><Text style={styles.bypassDot}>•</Text><Text style={styles.bypassText}>Resolved-alert confirmations from family</Text></View>
            <Text style={styles.bypassFoot}>
              Reminders for medications, activities, routines, missed check-ins, and family
              messages WILL be suppressed during Quiet Hours.
            </Text>
          </View>

          <TouchableOpacity
            testID="quiet-hours-save"
            onPress={onSave}
            disabled={!dirty || saving}
            activeOpacity={0.85}
            style={[styles.saveBtn, (!dirty || saving) && styles.saveBtnDisabled]}
          >
            {saving ? (
              <ActivityIndicator color={Colors.surface} />
            ) : (
              <Text style={styles.saveBtnText}>{dirty ? 'Save Quiet Hours' : 'Saved'}</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  scroll: { padding: 16, paddingBottom: 32 },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 14, padding: 14,
    gap: 12, marginBottom: 16, borderWidth: 1,
  },
  statusActive: { backgroundColor: '#1F2937', borderColor: '#374151' },
  statusInactive: { backgroundColor: Colors.tertiary, borderColor: Colors.primary },
  statusEmoji: { fontSize: 28 },
  statusTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  statusBody: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  card: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 4 },
  cardSub: { fontSize: 13, color: Colors.textTertiary, lineHeight: 18 },
  sectionLabel: {
    fontSize: 12, fontWeight: '800', color: Colors.textTertiary,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4, marginTop: 4,
  },
  sectionHelp: { fontSize: 13, color: Colors.textTertiary, marginBottom: 10, lineHeight: 18 },
  bypassCard: {
    backgroundColor: '#FEF3C7', borderRadius: 14, padding: 14, marginBottom: 18,
    borderWidth: 1, borderColor: '#FCD34D',
  },
  bypassTitle: { fontSize: 14, fontWeight: '800', color: '#92400E', marginBottom: 8 },
  bypassRow: { flexDirection: 'row', marginBottom: 4 },
  bypassDot: { fontSize: 14, color: '#92400E', width: 16 },
  bypassText: { fontSize: 13, color: '#78350F', flex: 1, lineHeight: 19 },
  bypassFoot: { fontSize: 12, color: '#92400E', marginTop: 8, fontStyle: 'italic', lineHeight: 17 },
  saveBtn: {
    height: 56, borderRadius: 16, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  saveBtnDisabled: { backgroundColor: Colors.border },
  saveBtnText: { color: Colors.surface, fontSize: 17, fontWeight: '800' },
});
