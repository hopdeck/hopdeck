// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { warnInConsole } from './console-warning.ts';
import { I18nProvider } from './i18n/I18nProvider.tsx';
import './styles/app.css';
import { applyTheme, loadThemeChoice } from './theme/theme.ts';

// Before the first render, so the page never flashes in the wrong theme.
applyTheme(loadThemeChoice());
warnInConsole();

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
