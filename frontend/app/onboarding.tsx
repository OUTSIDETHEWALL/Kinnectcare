import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { markOnboardingDone } from '../src/onboardingStore';

type Slide = {
  key: string;
  emoji: string;
  bg: string;
  title: string;
  body: string;
};

const SLIDES: Slide[] = [
  {
    key: 'welcome',
    emoji: '',
    bg: Colors.primary,
    title: 'Welcome to KinnectCare',
    body: 'A simple, caring app that helps families stay connected and look after the people who matter most.',
  },
  {
    key: 'checkins',
    emoji: '✅',
    bg: Colors.secondary,
    title: 'Daily Family Check-ins',
    body: 'Set a daily check-in time for each loved one. Get gentle alerts if they miss it so you can reach out — no nagging, just peace of mind.',
  },
  {
    key: 'wellness',
    emoji: '💊',
    bg: '#3F9E66',
    title: 'Senior Wellness Made Easy',
    body: 'Track medications and daily routines with flexible reminders. See weekly compliance at a glance, so nothing slips through the cracks.',
  },
  {
    key: 'sos',
    emoji: '🆘',
    bg: Colors.sos,
    title: 'One-Tap SOS Emergency',
    body: "When seconds count, a single tap shares your loved one's GPS location with family members instantly. Help is just a tap away.",
  },
];

export default function Onboarding() {
  const router = useRouter();
  const [index, setIndex] = useState(0);

  const isLast = index === SLIDES.length - 1;
  const isFirst = index === 0;
  const slide = SLIDES[index];

  const finish = async () => {
    await markOnboardingDone();
    router.replace('/');
  };

  const goNext = () => {
    if (isLast) return finish();
    setIndex(index + 1);
  };

  const goBack = () => {
    if (isFirst) return;
    setIndex(index - 1);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.topRow}>
        <TouchableOpacity
          testID="onboarding-back"
          onPress={goBack}
          hitSlop={12}
          disabled={isFirst}
          style={{ opacity: isFirst ? 0 : 1 }}
        >
          <Text style={styles.topNav}>‹ Back</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="onboarding-skip" onPress={finish} hitSlop={12}>
          <Text style={styles.topNav}>{isLast ? ' ' : 'Skip'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.slide} testID={`onboarding-slide-${slide.key}`}>
        <View style={[styles.illustration, { backgroundColor: slide.bg }]}>
          {slide.key === 'welcome' ? (
            <Image
              source={require('../assets/images/kinnectcare-logo-dark.png')}
              style={styles.logo}
              resizeMode="contain"
            />
          ) : (
            <Text style={styles.illustrationEmoji} accessibilityLabel={slide.title}>
              {slide.emoji}
            </Text>
          )}
        </View>
        <Text style={styles.title}>{slide.title}</Text>
        <Text style={styles.body}>{slide.body}</Text>
      </View>

      <View style={styles.dotsRow}>
        {SLIDES.map((s, i) => (
          <TouchableOpacity
            key={s.key}
            onPress={() => setIndex(i)}
            hitSlop={8}
            accessibilityLabel={`Go to slide ${i + 1}`}
          >
            <View style={[styles.dot, i === index && styles.dotActive]} />
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity
          testID="onboarding-next"
          style={styles.cta}
          onPress={goNext}
          activeOpacity={0.85}
        >
          <Text style={styles.ctaText}>{isLast ? 'Get Started' : 'Next'}</Text>
          {!isLast && <Text style={styles.ctaArrow}>›</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  topRow: {
    paddingHorizontal: 20, paddingTop: 8, height: 44,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  topNav: { fontSize: 15, fontWeight: '700', color: Colors.textSecondary },
  slide: { flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  illustration: {
    width: 220, height: 220, borderRadius: 110,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 36,
    ...Platform.select({
      web: { boxShadow: '0px 16px 32px rgba(27,94,53,0.22)' as any },
      default: { boxShadow: '0px 16px 32px rgba(27,94,53,0.22)' as any },
    }),
  },
  illustrationEmoji: { fontSize: 100 },
  logo: { width: 160, height: 160, borderRadius: 28 },
  title: {
    fontSize: 26, fontWeight: '800', color: Colors.textPrimary,
    textAlign: 'center', marginBottom: 14, lineHeight: 32,
  },
  body: {
    fontSize: 16, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 24, paddingHorizontal: 8,
  },
  dotsRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 8, marginBottom: 24, marginTop: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.border },
  dotActive: { width: 24, backgroundColor: Colors.primary },
  bottom: { paddingHorizontal: 28, paddingBottom: 12 },
  cta: {
    height: 58, borderRadius: 16, backgroundColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    boxShadow: '0px 8px 14px rgba(27,94,53,0.25)' as any,
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '800' },
  ctaArrow: { color: Colors.surface, fontSize: 22, fontWeight: '700' },
});
