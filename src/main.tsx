import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

// Register the PWA service worker (offline shell).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const { registerSW } = await import('virtual:pwa-register');
  registerSW({ immediate: true });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
