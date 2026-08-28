import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  getRefreshPipelineLog,
  PipelineEntry,
} from './refreshPipelineLog';
import {
  readPipelineSnapshots,
  StaleLocationPipelineSnapshot,
} from './pipelineSnapshot';

console.info('[diagnostics-bootloader] Section module evaluated module=pipeline');

type State = {
  loading: boolean;
  entries: PipelineEntry[];
  snapshots: StaleLocationPipelineSnapshot[];
};

export default class DiagnosticsPipelineSection extends React.Component<Record<string, never>, State> {
  state: State = {
    loading: true,
    entries: [],
    snapshots: [],
  };

  componentDidMount(): void {
    void this.load().catch((error) => {
      console.error(
        '[diagnostics-bootloader] Exception module=pipeline phase=component-initialization',
        error,
      );
      throw error;
    });
  }

  private load = async (): Promise<void> => {
    const [entries, snapshots] = await Promise.all([
      getRefreshPipelineLog(),
      readPipelineSnapshots(),
    ]);
    this.setState({ loading: false, entries, snapshots });
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
        <Text style={styles.title}>Pipeline</Text>
        <Text style={styles.summary}>
          {this.state.entries.length} refresh events · {this.state.snapshots.length} stale snapshots
        </Text>
        {this.state.entries.slice(0, 40).map((entry, index) => (
          <View key={`${entry.t}-${entry.stage}-${index}`} style={styles.row}>
            <Text style={styles.stage}>{entry.stage}</Text>
            <Text style={styles.time}>{new Date(entry.t).toLocaleString()}</Text>
            <Text style={styles.detail}>{JSON.stringify(entry)}</Text>
          </View>
        ))}
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 20, gap: 10 },
  title: { fontSize: 24, fontWeight: '800' },
  summary: { color: '#6B7280', marginBottom: 8 },
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  stage: { fontWeight: '700' },
  time: { color: '#6B7280', fontSize: 12 },
  detail: { color: '#374151', fontSize: 12 },
});