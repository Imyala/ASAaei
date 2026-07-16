import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Catch any render-time crash so the user sees a message and a way out instead
// of a silent blank screen. Reload clears the self-heal guard set in index.html
// so a fresh, cache-cleared attempt can run.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('ASAaei crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>Something went wrong</h1>
          <p>The app hit an unexpected error and couldn’t continue.</p>
          <pre>{String(this.state.error?.message || this.state.error)}</pre>
          <button
            className="primary"
            onClick={() => {
              try { sessionStorage.clear() } catch (e) { /* ignore */ }
              location.reload()
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
