import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

type SectionName = 'health-check' | 'motion-timeline' | 'pipeline' | 'full-diagnostics';
type SectionComponent = React.ComponentType;

type BootloaderState = {
  loading: SectionName | null;
  active: SectionName | null;
  Component: SectionComponent | null;
  error: Error | null;
};

const SECTION_LABELS: Record<SectionName, string> = {
  'health-check': 'Health Check',
  'motion-timeline': 'Motion Timeline',
  pipeline: 'Pipeline',
  'full-diagnostics': 'Full Diagnostics',
};

function lifecycle(message: string, error?: unknown): void {
  if (error === undefined) {
    console.info(`[diagnostics-bootloader] ${message}`);
  } else {
    console.error(`[diagnostics-bootloader] Exception ${message}`, error);
  }
}

class LoadedSection extends React.Component<{
  name: SectionName;
  Component: SectionComponent;
}> {
  componentDidMount(): void {
    lifecycle(`Component mounted successfully module=${this.props.name}`);
  }

  render(): ReactNode {
    const { Component } = this.props;
    return <Component />;
  }
}

export class DiagnosticsBootloader extends React.Component<Record<string, never>, BootloaderState> {
  constructor(props: Record<string, never>) {
    super(props);
    lifecycle('Navigation entered Diagnostics');
  }

  state: BootloaderState = {
    loading: null,
    active: null,
    Component: null,
    error: null,
  };

  componentDidMount(): void {
    lifecycle('Bootloader mounted');
  }

  private loadSection = async (name: SectionName): Promise<void> => {
    lifecycle(`Button pressed module=${name}`);
    lifecycle(`Dynamic import started module=${name}`);
    this.setState({ loading: name, active: null, Component: null, error: null });

    try {
      const imported = name === 'health-check'
        ? await import('./diagnosticsHealthSection')
        : name === 'motion-timeline'
          ? await import('./diagnosticsMotionSection')
          : name === 'pipeline'
            ? await import('./diagnosticsPipelineSection')
            : await import('./diagnosticsFull');
      lifecycle(`Dynamic import completed module=${name}`);
      this.setState({
        loading: null,
        active: name,
        Component: imported.default,
        error: null,
      });
    } catch (error) {
      lifecycle(`module=${name}`, error);
      this.setState({
        loading: null,
        active: name,
        Component: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  private reset = (): void => {
    this.setState({ loading: null, active: null, Component: null, error: null });
  };

  render(): ReactNode {
    const { loading, active, Component, error } = this.state;

    if (Component && active) {
      return (
        <View style={styles.loaded}>
          <TouchableOpacity style={styles.back} onPress={this.reset}>
            <Text style={styles.backText}>Back to bootloader</Text>
          </TouchableOpacity>
          <LoadedSection name={active} Component={Component} />
        </View>
      );
    }

    return (
      <View style={styles.root}>
        {loading ? <ActivityIndicator accessibilityLabel="Loading Diagnostics section" /> : null}
        {error ? (
          <Text style={styles.error}>
            {SECTION_LABELS[active ?? 'health-check']} import failed. See Logcat.
          </Text>
        ) : null}
        {(Object.keys(SECTION_LABELS) as SectionName[]).map((name) => (
          <TouchableOpacity
            key={name}
            style={styles.button}
            onPress={() => { void this.loadSection(name); }}
            disabled={loading !== null}
            accessibilityRole="button"
            accessibilityLabel={SECTION_LABELS[name]}
          >
            <Text style={styles.buttonText}>{SECTION_LABELS[name]}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  button: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: '#155E75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  loaded: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  back: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  backText: {
    color: '#155E75',
    fontWeight: '700',
  },
  error: {
    color: '#B91C1C',
    textAlign: 'center',
  },
});