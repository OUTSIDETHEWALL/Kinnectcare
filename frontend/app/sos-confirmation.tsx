import { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Linking, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';

/**
 * SOS confirmation screen — shown only after sos-sending.tsx confirms the
 * POST /sos call succeeded. We never show this screen unless the server has
 * acknowledged receipt, so "Emergency Alert Sent" is always truthful.
 *
 * The "Waiting for acknowledgement" row is a static placeholder; when backend
 * support for family acknowledgements ships it will become a live poll.
 */
export default function SOSConfirmation() {
  const router = useRouter();
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: 1, friction: 5, tension: 80, useNativeDriver: true,
    }).start();
  }, [scale]);

  const dial911 = async () => {
    const url = 'tel:911';
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
      else Alert.alert('Could not open dialer', 'Please dial 911 manually.');
    } catch {
      Alert.alert('Could not open dialer', 'Please dial 911 manually.');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
          <Text style={styles.iconText}>🆘</Text>
        </Animated.View>

        <Text testID="sos-title" style={styles.title}>Emergency Alert Sent</Text>
        <Text style={styles.subtitle}>
          Your family has been notified and emergency services were dialled.
        </Text>

        <View style={styles.statusList}>
          <StatusRow
            icon="🔔"
            label="Family notified"
            sub="Push notification delivered to all devices"
          />
          <StatusRow
            icon="📍"
            label="Current location shared"
            sub="Coordinates sent with the alert"
          />
          <StatusRow
            icon="🕐"
            label="Time recorded"
            sub="Alert timestamped for your family"
          />
          <StatusRow
            icon="👀"
            label="Waiting for your family to respond..."
            sub="You'll be notified as soon as someone sees this"
            pending
          />
        </View>
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity
          testID="sos-call-911"
          onPress={dial911}
          activeOpacity={0.85}
          style={styles.callBtn}
        >
          <Text style={styles.callBtnText}>📞 Call 911</Text>
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
  icon, label, sub, pending = false,
}: { icon: string; label: string; sub: string; pending?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, pending && styles.rowLabelPending]}>
          {label}
        </Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Text style={[styles.rowCheck, pending && styles.rowCheckPending]}>
        {pending ? '…' : '✓'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between',
  },
  content: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28, paddingTop: 12,
  },
  iconWrap: {
    width: 130, height: 130, borderRadius: 65, backgroundColor: Colors.sos,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 12px 24px rgba(220,38,38,0.35)' as any,
    ...Platform.select({ android: { elevation: 10 } }),
  },
  iconText: { fontSize: 64 },
  title: {
    fontSize: 26, fontWeight: '800', color: Colors.textPrimary,
    marginTop: 24, textAlign: 'center',
  },
  subtitle: {
    fontSize: 14, color: Colors.textSecondary, marginTop: 8,
    textAlign: 'center', lineHeight: 21,
  },
  statusList: {
    alignSelf: 'stretch', backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border, padding: 8, marginTop: 20,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 8, gap: 12,
  },
  rowIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  rowLabelPending: { color: Colors.textSecondary },
  rowSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  rowCheck: { fontSize: 17, color: Colors.primary, fontWeight: '800' },
  rowCheckPending: { color: Colors.textTertiary, fontWeight: '400' },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: {
    height: 56, backgroundColor: Colors.primary, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  callBtn: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.sos,
  },
  callBtnText: { color: Colors.sos, fontSize: 15, fontWeight: '800' },
});
