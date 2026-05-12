import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';

export default function CheckInConfirm() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: 1,
      friction: 5,
      tension: 80,
      useNativeDriver: true,
    }).start();
  }, [scale]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Animated.View style={[styles.checkCircle, { transform: [{ scale }] }]}>
          <Icon name="checkmark" size={80} color={Colors.surface} />
        </Animated.View>
        <Text testID="checkin-title" style={styles.title}>You're checked in!</Text>
        <Text style={styles.subtitle}>
          {name ? `${name} is safely checked in.` : 'Your family has been notified.'}
        </Text>
        <View style={styles.timeRow}>
          <Icon name="time-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.timeText}>Just now</Text>
        </View>
      </View>
      <View style={styles.bottom}>
        <TouchableOpacity
          testID="checkin-done"
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  checkCircle: {
    width: 160, height: 160, borderRadius: 80, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 10,
  },
  title: { fontSize: 32, fontWeight: '800', color: Colors.textPrimary, marginTop: 36, textAlign: 'center' },
  subtitle: { fontSize: 17, color: Colors.textSecondary, marginTop: 12, textAlign: 'center', lineHeight: 26 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18 },
  timeText: { color: Colors.textTertiary, fontSize: 14 },
  bottom: { paddingHorizontal: 24, paddingBottom: 24 },
  cta: { height: 60, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
