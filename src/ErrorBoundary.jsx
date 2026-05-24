import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight:'100vh', background:'#0f172a', color:'#f1f5f9', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'2rem', fontFamily:'monospace' }}>
        <div style={{ fontSize:'2rem', marginBottom:'1rem' }}>⚠️ App Error</div>
        <div style={{ background:'#1e293b', borderRadius:'0.75rem', padding:'1.5rem', maxWidth:'600px', width:'100%', wordBreak:'break-word' }}>
          <p style={{ color:'#f87171', fontWeight:'bold', marginBottom:'0.5rem' }}>{this.state.error?.name}: {this.state.error?.message}</p>
          <pre style={{ color:'#94a3b8', fontSize:'0.75rem', whiteSpace:'pre-wrap', marginTop:'0.75rem' }}>{this.state.error?.stack}</pre>
        </div>
        <button
          onClick={() => { localStorage.clear(); window.location.reload(); }}
          style={{ marginTop:'1.5rem', background:'#3b82f6', color:'white', border:'none', borderRadius:'0.5rem', padding:'0.75rem 1.5rem', cursor:'pointer', fontSize:'1rem' }}
        >
          Clear cache &amp; reload
        </button>
      </div>
    );
  }
}
