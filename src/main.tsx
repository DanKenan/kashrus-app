import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { initSwUpdates, onNewVersionActivated } from './lib/swUpdate';
import App from './App.tsx';
import './index.css';

// Register the PWA service worker. When a new version takes over and when the
// page reloads is decided in one place, lib/swUpdate.ts: on open (a waiting
// update takes over before anyone starts working), or from the "Update app"
// button — never in the middle of someone's work. Every update reload goes
// through its loop guard.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    initSwUpdates(registration);
  },
  onNeedReload() {
    // A new version became active (here or in another tab).
    onNewVersionActivated();
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

