// Minimal ambient type so the adapter compiles without Next installed. Next's own types win when present.
declare module 'next/headers' {
  export function cookies(): unknown;
}
