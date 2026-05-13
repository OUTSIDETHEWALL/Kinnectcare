import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from './Icon';
import { Colors } from './theme';
import {
  LegalSection, COMPANY_NAME, APP_NAME, LEGAL_EFFECTIVE_DATE, CONTACT_EMAIL,
} from './legal';

type Props = {
  title: string;
  intro: string;
  sections: LegalSection[];
  testIDPrefix?: string;
};

export function LegalScreen({ title, intro, sections, testIDPrefix = 'legal' }: Props) {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID={`${testIDPrefix}-back`}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={styles.backBtn}
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.appName}>{APP_NAME}</Text>
        <Text style={styles.company}>by {COMPANY_NAME}</Text>
        <Text style={styles.effective}>Effective {LEGAL_EFFECTIVE_DATE}</Text>

        <Text style={styles.intro}>{intro}</Text>

        {sections.map((s, idx) => (
          <View key={idx} style={styles.section} testID={`${testIDPrefix}-section-${idx}`}>
            <Text style={styles.sectionHeading}>{s.heading}</Text>
            <Text style={styles.sectionBody}>{s.body}</Text>
          </View>
        ))}

        <View style={styles.footerBox}>
          <Text style={styles.footerText}>
            Need help? Contact us at{' '}
            <Text style={styles.footerEmail}>{CONTACT_EMAIL}</Text>
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, flex: 1, textAlign: 'center' },
  scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 56 },
  appName: { fontSize: 22, fontWeight: '800', color: Colors.primary, textAlign: 'center' },
  company: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 2 },
  effective: { fontSize: 13, color: Colors.textTertiary, textAlign: 'center', marginTop: 6, marginBottom: 18 },
  intro: { fontSize: 15, lineHeight: 22, color: Colors.textPrimary, marginBottom: 6 },
  section: { marginTop: 18 },
  sectionHeading: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 6 },
  sectionBody: { fontSize: 14.5, lineHeight: 22, color: Colors.textSecondary },
  footerBox: {
    marginTop: 28,
    padding: 16,
    borderRadius: 14,
    backgroundColor: Colors.tertiary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  footerText: { fontSize: 14, color: Colors.textPrimary, textAlign: 'center' },
  footerEmail: { fontWeight: '700', color: Colors.primary },
});
