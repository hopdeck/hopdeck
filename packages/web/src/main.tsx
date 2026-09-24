import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nProvider } from './i18n/I18nProvider.tsx';
import './styles/app.css';
import { applyTheme, loadThemeChoice } from './theme/theme.ts';

// Before the first render, so the page never flashes in the wrong theme.
applyTheme(loadThemeChoice());

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
