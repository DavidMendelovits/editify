/**
 * Design tokens. Every colour, corner radius, spacing step, and type size in
 * the app comes from here — restyle here, not per component.
 *
 * Direction: a professional NLE. Neutral dark greys, one accent used only for
 * state (selected, active, in progress), tight spacing, near-square corners.
 * All text/background pairs below clear WCAG AA (4.5:1) — see the ratios in
 * the PR for #23 before changing a value.
 */
export const colors = {
  background: '#0E0E10',
  panel: '#161618',
  panelRaised: '#1E1E21',
  /** Recessed surfaces: the timeline body, the stage, code, lists. */
  panelSunken: '#0A0A0C',
  border: '#2E2E33',
  borderStrong: '#3C3C42',
  text: '#ECECEE',
  muted: '#9A9AA3',
  /** Selection, active, focus. Text and borders only — 5.7:1 on every surface. */
  accent: '#5B9BFF',
  /** Filled controls that carry white text (5.2:1). */
  accentStrong: '#2F6BC7',
  accentSoft: '#172236',
  success: '#4CC98A',
  successSoft: '#12261B',
  danger: '#F0656B',
  dangerSoft: '#2A1417',
  warn: '#E0B15A',
  warnSoft: '#2E2412',
} as const;

/** Near-square everywhere; `full` only for things that are genuinely round (a radio, the record button). */
export const radius = { sm: 2, md: 3, lg: 4, full: 999 } as const;

export const space = { xs: 2, sm: 4, md: 6, lg: 8, xl: 10, xxl: 14, section: 20 } as const;

export const type = { xs: 8, sm: 9, md: 10, base: 11, lg: 12, xl: 14, xxl: 16, title: 20, display: 28 } as const;

export const fonts = {
  regular: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  semibold: 'SpaceGrotesk_600SemiBold',
  bold: 'SpaceGrotesk_700Bold',
  display: 'Unbounded_700Bold',
  mono: 'SpaceMono_700Bold',
} as const;
