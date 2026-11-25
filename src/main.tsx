import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { applyAccent, loadAccent } from './accent.ts';
import { registerTilt } from './motion.ts';

// Before the first render, so the saved accent never flashes the default.
applyAccent(loadAccent(), false);
registerTilt();
// Ask the browser not to evict our storage (saved stops and routes).
void navigator.storage?.persist?.();

createRoot(document.getElementById('root')!).render(<App />);

// Offline shell: the service worker only runs in the production build (dev would cache stale modules).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  });
}
