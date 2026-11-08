import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';

/** If anything throws while rendering, show what happened instead of a blank window. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-box">
          <h2>Something went wrong</h2>
          <p>Calamus hit an error while drawing the window. Your unsaved text is kept in the session.</p>
          <pre>{String(this.state.error.stack || this.state.error.message).slice(0, 1200)}</pre>
          <div className="dialog-actions">
            <button className="btn secondary" onClick={() => { try { localStorage.removeItem('calamus.session'); } catch { /* ignore */ } location.reload(); }}>Reset session</button>
            <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
