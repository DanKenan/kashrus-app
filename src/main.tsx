import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { registerSW } from 'virtual:pwa-register';
import { initSwUpdates, onNewVersionActivated } from './lib/swUpdate';
import App from './App.tsx';
import { UpdateBanner } from './components/UpdateBanner';
import './index.css';

// Register the PWA service worker. When a new version takes over and when the
// page reloads is decided in one place, lib/swUpdate.ts: never on its own,
// only from a tap on the "Tap to update" bar (UpdateBanner) or the "Update
// app" button. Every update reload goes through its loop guard.
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
    <MotionConfig reducedMotion="user">
      <App />
      <UpdateBanner />
    </MotionConfig>
  </StrictMode>,
);

