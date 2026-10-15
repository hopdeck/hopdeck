// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

// Vitest (through Vite) loads any file as text with the ?raw suffix.
declare module '*?raw' {
  const text: string;
  export default text;
}
