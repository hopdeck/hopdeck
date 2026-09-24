// Vitest (through Vite) loads any file as text with the ?raw suffix.
declare module '*?raw' {
  const text: string;
  export default text;
}
