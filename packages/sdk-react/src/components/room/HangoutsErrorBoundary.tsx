import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

export class HangoutsErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="hh-room" style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Something went wrong</p>
          <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: '1rem' }}>
            {this.state.error.message}
          </p>
          <button
            className="hh-btn hh-btn--secondary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
