import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register PWA service worker: check for updates on open, but NEVER force a
// reload mid-session — that was white-screening the app on busy deploy days.
// A new version activates quietly in the background and takes over on next open.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Activate the waiting service worker without reloading this page.
    updateSW(false);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

