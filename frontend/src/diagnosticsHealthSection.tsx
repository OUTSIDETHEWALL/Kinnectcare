import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  getEngineDiagnostics,
  getPipelineTimestamps,
} from './locationEngine';
import { computeDiagnosticsHealthItems } from './diagnosticsHealthItems';
import { healthIcon, HealthItem } from './healthCheck';

console.info('[diagnostics-bootloader] Section module evaluated module=health-check');

type State = {
  loading: boolean;
  items: HealthItem[];
};

export default class DiagnosticsHealthSection extends React.Component<Record<string, never>, State> {
  state: State = {
    loading: true,
    items: [],
  };

  componentDidMount(): void {
    void this.load().catch((error) => {
      console.error(
        '[diagnostics-bootloader] Exception module=health-check phase=component-initialization',
        error,
      );
      throw error;
    });
  }

  private load = async (): Promise<void> => {
    const [engine, pipeline] = await Promise.all([
      getEngineDiagnostics(),
      getPipelineTimestamps(),
    ]);
    this.setState({
      loading: false,
      items: computeDiagnosticsHealthItems(engine.log, Date.now(), pipeline),
    });
  };

  render(): ReactNode {
    if (this.state.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Health Check</Text>
        {this.state.items.map((item) => (
          <View key={item.label} style={styles.row}>
            <Text style={styles.icon}>{healthIcon(item.status)}</Text>
            <Text style={styles.label}>{item.label}</Text>
            <Text style={styles.status}>{item.status}</Text>
          </View>
        ))}
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 20, gap: 10 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 8 },
  row: {
    minHeight: 52,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: { fontSize: 18 },
  label: { flex: 1, fontSize: 15 },
  status: { color: '#6B7280', textTransform: 'uppercase', fontSize: 11 },
});