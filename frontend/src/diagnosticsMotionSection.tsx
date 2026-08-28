import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EngineLogEvent,
  getEngineDiagnostics,
} from './locationEngine';

console.info('[diagnostics-bootloader] Section module evaluated module=motion-timeline');

const MOTION_EVENTS = new Set([
  'sdk_onActivityChange',
  'sdk_onMotionChange',
  'sdk_onLocation',
  'sdk_onHttp',
  'headless_heartbeat_ok',
]);

type State = {
  loading: boolean;
  events: EngineLogEvent[];
};

export default class DiagnosticsMotionSection extends React.Component<Record<string, never>, State> {
  state: State = {
    loading: true,
    events: [],
  };

  componentDidMount(): void {
    void this.load().catch((error) => {
      console.error(
        '[diagnostics-bootloader] Exception module=motion-timeline phase=component-initialization',
        error,
      );
      throw error;
    });
  }

  private load = async (): Promise<void> => {
    const engine = await getEngineDiagnostics();
    this.setState({
      loading: false,
      events: engine.log.filter((entry) => MOTION_EVENTS.has(entry.event)),
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
        <Text style={styles.title}>Motion Timeline</Text>
        {this.state.events.length === 0 ? (
          <Text style={styles.empty}>No motion events recorded.</Text>
        ) : this.state.events.map((entry, index) => (
          <View key={`${entry.at}-${entry.event}-${index}`} style={styles.row}>
            <Text style={styles.event}>{entry.event}</Text>
            <Text style={styles.time}>{new Date(entry.at).toLocaleString()}</Text>
            {entry.detail ? (
              <Text style={styles.detail}>{JSON.stringify(entry.detail)}</Text>
            ) : null}
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
  empty: { color: '#6B7280' },
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  event: { fontWeight: '700' },
  time: { color: '#6B7280', fontSize: 12 },
  detail: { color: '#374151', fontSize: 12 },
});