import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Linking, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';

export default function SOSConfirm() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string }>();
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

  const callAgain = () => {
    Linking.openURL('tel:911').catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Animated.View style={[styles.iconWrap, { transform: [{ scale: Animated.multiply(scale, pulse) }] }]}>
          <Text style={styles.iconText}>🆘</Text>
        </Animated.View>
        <Text testID="sos-title" style={styles.title}>SOS Sent</Text>
        <Text style={styles.subtitle}>
          {name ? `${name}'s emergency has been broadcast.` : 'Your emergency has been broadcast.'}
        </Text>

        <View style={styles.statusList}>
          <StatusRow icon="📞" label="Calling 911" sub="Emergency services are being contacted" />
          <StatusRow icon="📍" label="Sharing GPS location" sub="Coordinates sent to your family" />
          <StatusRow icon="🔔" label="Family notified" sub="Push notification delivered to all devices" />
        </View>

        <View style={styles.timeRow}>
          <Icon name="time-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.timeText}>Just now</Text>
        </View>
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity testID="sos-call-again" onPress={callAgain} activeOpacity={0.85} style={styles.secondary}>
          <Text style={styles.secondaryText}>📞 Call 911 again</Text>
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

function StatusRow({ icon, label, sub }: { icon: string; label: string; sub: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Text style={styles.rowCheck}>✓</Text>
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
  iconText: { fontSize: 72 },
  title: { fontSize: 30, fontWeight: '800', color: Colors.textPrimary, marginTop: 28, textAlign: 'center' },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 22 },
  statusList: {
    alignSelf: 'stretch', backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border, padding: 8, marginTop: 24,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, gap: 12 },
  rowIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  rowSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  rowCheck: { fontSize: 18, color: Colors.primary, fontWeight: '800' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18 },
  timeText: { color: Colors.textTertiary, fontSize: 13 },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: { height: 56, backgroundColor: Colors.primary, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  secondary: {
    height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.sos,
  },
  secondaryText: { color: Colors.sos, fontSize: 16, fontWeight: '800' },
});
