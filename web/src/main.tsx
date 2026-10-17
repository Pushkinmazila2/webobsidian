import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installBaseEmbedRenderer } from './components/baseEmbed';
import { installHoverLinks } from './lib/hoverPreview';
import './styles/obsidian.css';

// NOTE: /share/<id> never reaches the SPA — the server renders it (SEO/OG SSR).

installBaseEmbedRenderer();
installHoverLinks();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
