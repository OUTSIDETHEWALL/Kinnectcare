import React, { ErrorInfo, ReactNode } from 'react';

type Props = {
  record: unknown;
  renderRecord: () => ReactNode;
  onError: (error: Error, componentStack: string, record: unknown) => void;
};

function DiagnosticsRecordRenderer({
  renderRecord,
}: {
  renderRecord: () => ReactNode;
}) {
  return <>{renderRecord()}</>;
}

class RecordErrorBoundary extends React.Component<
  Props,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(error, info.componentStack ?? '', this.props.record);
  }

  render(): ReactNode {
    if (this.state.hasError) return null;
    return <DiagnosticsRecordRenderer renderRecord={this.props.renderRecord} />;
  }
}

export function DiagnosticsRecordCrashBoundary(props: Props) {
  return <RecordErrorBoundary {...props} />;
}