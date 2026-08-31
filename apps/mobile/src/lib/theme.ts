export const colors = {
  background: '#000000',
  panel: '#16171D',
  panelRaised: '#1B1D24',
  border: '#35374A',
  text: '#FAFAFA',
  muted: '#9CA0AF',
  blue: '#2563EB',
  purple: '#8B5CF6',
  pink: '#F43F9D',
  success: '#39D98A',
  danger: '#FF5C70',
};

export const fonts = {
  regular: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  semibold: 'SpaceGrotesk_600SemiBold',
  bold: 'SpaceGrotesk_700Bold',
  display: 'Unbounded_700Bold',
  mono: 'SpaceMono_700Bold',
} as const;

export const gradient = [colors.blue, colors.purple, colors.pink] as const;
