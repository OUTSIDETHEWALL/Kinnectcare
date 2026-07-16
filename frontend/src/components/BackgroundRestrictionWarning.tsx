/**
 * BackgroundRestrictionWarning
 *
 * A non-blocking amber warning card shown on the Diagnostics screen
 * when background restriction evidence has been positively detected.
 *
 * Renders nothing when no condition is confirmed (isRestricted === false).
 * Never shown based on speculation — only on concrete logged evidence.
 *
 * Design notes:
 *   - warningBg / warning from the theme — no new palette entries needed.
 *   - "Open Settings" routes to the app's Android Settings page so the
 *     user can navigate to Battery → Battery optimization or
 *     Location → Allow all the time.
 *   - iOS is omitted from "Open Settings" — iOS battery management is
 *     not user-configurable at the same level and the copy is Android-
 *     specific.
 */
import { View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import { Colors } from '../theme';
import type { RestrictionStatus } from '../backgroundRestrictionDetector';

type Props = {
  status: RestrictionStatus;
};

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function BackgroundRestrictionWarning({ status }: Props) {
  if (!status.isRestricted) return null;

  const conditions: string[] = [];
  if (status.powerSaveActive) conditions.push('Battery Save mode is currently on');
  if (status.restartBlockedByOs) conditions.push('OS blocked a background restart attempt');
  if (status.leonidasRestartFailed) conditions.push('Engine restart attempt failed');

  async function onOpenSettings() {
    try {
      await Linking.openSettings();
    } catch (_e) {
      // openSettings() unavailable — nothing further we can do
    }
  }

  return (
    <View style={styles.card} testID="diagnostics-restriction-warning">
      <Text style={styles.title}>⚠  Background Tracking Needs Attention</Text>
      <Text style={styles.body}>
        Kinnship has detected that Android may be limiting background tracking
        on this device. While this is happening, location updates may be delayed
        when the app is closed.
      </Text>

      <View style={styles.divider} />

      <Text style={styles.sectionLabel}>For best performance:</Text>
      <Text style={styles.bullet}>• Battery: Unrestricted</Text>
      <Text style={styles.bullet}>• Location: Allow all the time</Text>

      {conditions.length > 0 && (
        <View style={styles.evidence}>
          <Text style={styles.evidenceLabel}>Detected:</Text>
          {conditions.map((c, i) => (
            <Text key={i} style={styles.evidenceItem}>· {c}</Text>
          ))}
          {status.lastEvidenceAt != null && (
            <Text style={styles.evidenceTime}>
              Last seen: {fmtTime(status.lastEvidenceAt)}
            </Text>
          )}
        </View>
      )}

      {Platform.OS === 'android' && (
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={onOpenSettings}
          accessibilityLabel="Open Android settings for Kinnship"
          activeOpacity={0.8}
        >
          <Text style={styles.settingsBtnText}>Open Settings</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const AMBER_BORDER = '#FCD34D';

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.warningBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: AMBER_BORDER,
    padding: 16,
    marginBottom: 20,
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.warning,
    lineHeight: 20,
  },
  body: {
    fontSize: 13.5,
    color: Colors.textPrimary,
    lineHeight: 19,
  },
  divider: {
    height: 1,
    backgroundColor: AMBER_BORDER,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  bullet: {
    fontSize: 13,
    color: Colors.textPrimary,
    lineHeight: 19,
    marginLeft: 4,
  },
  evidence: {
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: AMBER_BORDER,
    gap: 3,
  },
  evidenceLabel: {
    fontSize: 11.5,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginBottom: 2,
  },
  evidenceItem: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  evidenceTime: {
    fontSize: 11,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  settingsBtn: {
    height: 40,
    borderRadius: 8,
    backgroundColor: Colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsBtnText: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
