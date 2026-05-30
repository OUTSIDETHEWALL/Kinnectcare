import { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Linking, Platform, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';

/**
 * SOS status screen — shown right after the user confirms an SOS from the
 * dashboard. The dashboard hands us a `dialed` param indicating whether the
 * OS actually accepted our `tel:911` intent.
 *
 * IMPORTANT: we must NEVER claim "Calling 911" or show a green checkmark for
 * a dial that didn't happen — that's the dangerous bug we just fixed. If
 * `dialed === '0'`, surface a prominent red warning and a "Call 911 now"
 * button instead.
 */
export default function SOSConfirm() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; dialed?: string }>();
  const dialed = params.dialed === '1';
  const scale = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: 1, friction: 5, tension: 80, useNativeDriver: true,
    }).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    ).start();
  }, [scale, pulse]);

  const dial911 = async () => {
    const url = 'tel:911';
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
      else {
        Alert.alert(
          'Could not open dialer',
          'This device does not allow opening the phone dialer from apps. Please dial 911 manually.',
        );
      }
    } catch {
      Alert.alert(
        'Could not open dialer',
        'Please dial 911 manually.',
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Animated.View
          style={[
            styles.iconWrap,
            { transform: [{ scale: Animated.multiply(scale, pulse) }] },
            !dialed && styles.iconWrapWarn,
          ]}
        >
          <Text style={styles.iconText}>🆘</Text>
        </Animated.View>

        <Text testID="sos-title" style={styles.title}>
          {dialed ? 'Help is on the way' : 'SOS Sent — call 911 now'}
        </Text>
        <Text style={styles.subtitle}>
          {params.name
            ? `${params.name}'s emergency has been broadcast to family.`
            : 'Your emergency has been broadcast to family.'}
        </Text>

        {/* Dialer failure banner — only when tel:911 did NOT open */}
        {!dialed ? (
          <View style={styles.warnBox} testID="sos-dial-failed">
            <Text style={styles.warnEmoji}>⚠️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.warnTitle}>The phone dialer did not open</Text>
              <Text style={styles.warnBody}>
                Tap the red button below to call 911 right now, or dial 911 manually from your phone.
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.statusList}>
          <StatusRow
            icon="📞"
            label={dialed ? 'Phone dialer opened' : 'Dialer did NOT open'}
            sub={dialed ? '911 was pre-filled — tap Call to connect' : 'Use the red button to retry'}
            ok={dialed}
          />
          <StatusRow
            icon="📍"
            label="Sharing GPS location"
            sub="Coordinates sent to your family"
            ok
          />
          <StatusRow
            icon="🔔"
            label="Family notified"
            sub="Push notification delivered to all devices"
            ok
          />
        </View>

        <View style={styles.timeRow}>
          <Icon name="time-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.timeText}>Just now</Text>
        </View>
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity
          testID="sos-call-911"
          onPress={dial911}
          activeOpacity={0.85}
          style={[styles.callBtn, !dialed && styles.callBtnUrgent]}
        >
          <Text style={[styles.callBtnText, !dialed && styles.callBtnTextUrgent]}>
            {dialed ? '📞 Call 911 again' : '📞 Call 911 now'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="sos-done"
          onPress={() => router.replace('/(tabs)/dashboard')}
          activeOpacity={0.85}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function StatusRow({
  icon, label, sub, ok,
}: { icon: string; label: string; sub: string; ok: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, !ok && { color: Colors.error }]}>{label}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Text style={[styles.rowCheck, !ok && { color: Colors.error }]}>{ok ? '✓' : '✗'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingTop: 12 },
  iconWrap: {
    width: 140, height: 140, borderRadius: 70, backgroundColor: Colors.sos,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 12px 24px rgba(220,38,38,0.35)' as any,
    ...Platform.select({ android: { elevation: 10 } }),
  },
  iconWrapWarn: { backgroundColor: Colors.warning },
  iconText: { fontSize: 72 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 24, textAlign: 'center' },
  subtitle: { fontSize: 15, color: Colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 22 },

  warnBox: {
    flexDirection: 'row', gap: 10, alignSelf: 'stretch',
    backgroundColor: '#FFF4E5', borderColor: '#F2C46A', borderWidth: 1,
    borderRadius: 14, padding: 14, marginTop: 18,
  },
  warnEmoji: { fontSize: 22 },
  warnTitle: { fontSize: 14, fontWeight: '800', color: '#7A4A00' },
  warnBody: { fontSize: 13, color: '#7A4A00', marginTop: 4, lineHeight: 18 },

  statusList: {
    alignSelf: 'stretch', backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border, padding: 8, marginTop: 18,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, gap: 12 },
  rowIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  rowSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  rowCheck: { fontSize: 18, color: Colors.primary, fontWeight: '800' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  timeText: { color: Colors.textTertiary, fontSize: 13 },

  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: { height: 56, backgroundColor: Colors.primary, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  callBtn: {
    height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.sos,
  },
  callBtnText: { color: Colors.sos, fontSize: 16, fontWeight: '800' },
  // Urgent variant — used when the dial actually failed. Solid red, high
  // contrast, biggest visual weight on the screen.
  callBtnUrgent: {
    backgroundColor: Colors.sos, borderColor: Colors.sos,
    boxShadow: '0px 6px 14px rgba(220,38,38,0.45)' as any,
    ...Platform.select({ android: { elevation: 6 } }),
  },
  callBtnTextUrgent: { color: Colors.surface, fontSize: 17, fontWeight: '900' },
});
