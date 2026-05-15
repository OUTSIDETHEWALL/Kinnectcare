import { View, Text, StyleSheet, TouchableOpacity, ImageBackground, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Welcome() {
  const router = useRouter();

  return (
    <ImageBackground
      source={{ uri: 'https://images.unsplash.com/photo-1770520214803-9af048351642?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxNzV8MHwxfHNlYXJjaHwxfHxhYnN0cmFjdCUyMGdyZWVuJTIwYW5kJTIwd2hpdGUlMjBmbHVpZCUyMGJhY2tncm91bmR8ZW58MHx8fHwxNzc4NTQxNjg1fDA&ixlib=rb-4.1.0&q=85' }}
      style={styles.bg}
      imageStyle={{ opacity: 0.5 }}
    >
      <View style={styles.overlay} />
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.top}>
          <View style={styles.logoFrame}>
            <Image
              source={require('../assets/images/kinnship-logo-dark.png')}
              style={styles.logoImage}
              resizeMode="contain"
              accessibilityLabel="Kinnship"
            />
          </View>
          <Text style={styles.tagline}>Family safety & senior wellness, all in one place.</Text>
        </View>

        <View style={styles.featureRow}>
          <FeatureItem icon="people" label="Family" />
          <FeatureItem icon="heart" label="Wellness" />
          <FeatureItem icon="alert-circle" label="Alerts" />
        </View>

        <View style={styles.bottom}>
          <TouchableOpacity
            testID="get-started-btn"
            style={styles.cta}
            activeOpacity={0.85}
            onPress={() => router.push('/(auth)/signup')}
          >
            <Text style={styles.ctaText}>Get Started</Text>
            <Icon name="arrow-forward" size={20} color={Colors.surface} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="welcome-login-link"
            onPress={() => router.push('/(auth)/login')}
            style={styles.loginLink}
          >
            <Text style={styles.loginLinkText}>
              I already have an account · <Text style={{ fontWeight: '700' }}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
}

function FeatureItem({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={styles.featureItem}>
      <View style={styles.featureIconBubble}>
        <Icon name={icon} size={22} color={Colors.primary} />
      </View>
      <Text style={styles.featureLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.background },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(249,245,240,0.82)' },
  container: { flex: 1, paddingHorizontal: 28, justifyContent: 'space-between' },
  top: { alignItems: 'center', marginTop: 24 },
  // Dark-green frame that visually extends the PNG's box upward, giving the
  // shield breathing room at the top. The frame color matches the PNG's
  // outermost corner color (#072815) so the wrapper and the PNG blend into a
  // single seamless dark-green rounded rectangle.
  logoFrame: {
    width: 200,
    height: 200,
    borderRadius: 40,
    backgroundColor: '#072815',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
    paddingBottom: 0,
  },
  logoImage: {
    width: 180, height: 180,
  },
  tagline: {
    fontSize: 17, color: Colors.textSecondary, textAlign: 'center',
    marginTop: 12, paddingHorizontal: 12, lineHeight: 26,
  },
  featureRow: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: 32 },
  featureItem: { alignItems: 'center' },
  featureIconBubble: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  featureLabel: { marginTop: 8, fontSize: 14, fontWeight: '600', color: Colors.textSecondary },
  bottom: { marginBottom: 24 },
  cta: {
    height: 60, backgroundColor: Colors.primary, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    boxShadow: '0px 8px 14px rgba(27,94,53,0.25)', elevation: 6,
  },
  ctaText: { color: Colors.surface, fontSize: 18, fontWeight: '700' },
  loginLink: { marginTop: 18, alignItems: 'center' },
  loginLinkText: { fontSize: 15, color: Colors.textSecondary },
});
