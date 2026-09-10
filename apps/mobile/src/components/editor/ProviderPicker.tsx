import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentProviderId, type ProviderStatus } from '../../lib/api';
import { colors, radius, space, type, fonts } from '../../lib/theme';

/** Short enough for the collapsed chip; the full label lives in the open list. */
const SHORT: Record<AgentProviderId, string> = {
  'claude-cli': 'claude cli',
  'codex-cli': 'codex cli',
  anthropic: 'anthropic api',
  openai: 'openai api',
  mock: 'offline mock',
};

/**
 * Chooses which model runs the agent. The server owns the list — it probes for
 * the CLIs and the API keys — so unavailable options stay visible but disabled
 * with the reason attached, rather than silently missing.
 */
export function ProviderPicker() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['agent-provider'], queryFn: () => api.getAgentProvider() });
  const select = useMutation({
    mutationFn: (provider: AgentProviderId) => api.setAgentProvider(provider),
    onSuccess: (status: ProviderStatus) => {
      queryClient.setQueryData(['agent-provider'], status);
      setOpen(false);
    },
  });

  const status = statusQuery.data;
  const active = status?.active;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="choose the model running the agent"
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      >
        <View style={[styles.dot, active === 'mock' && styles.dotMock]} />
        <Text style={styles.chipText}>{active ? SHORT[active] : 'loading…'}</Text>
        <Text style={styles.caret}>{open ? '▴' : '▾'}</Text>
      </Pressable>

      {status?.requested && (
        <Text style={styles.warning}>{SHORT[status.requested]} is unavailable, running {SHORT[status.active]}</Text>
      )}

      {open && (
        <View style={styles.list}>
          {status?.options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              disabled={!option.available || select.isPending}
              onPress={() => select.mutate(option.id)}
              style={({ pressed }) => [
                styles.option,
                option.id === active && styles.optionActive,
                !option.available && styles.optionDisabled,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.optionHead}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.id === active && <Text style={styles.activeTag}>ACTIVE</Text>}
                {select.isPending && select.variables === option.id && <ActivityIndicator size="small" color={colors.accent} />}
              </View>
              <Text style={styles.optionDetail}>{option.detail}</Text>
            </Pressable>
          ))}
          {select.error && <Text style={styles.warning}>{select.error.message}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, alignSelf: 'flex-start',
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  dot: { width: 5, height: 5, borderRadius: radius.md, backgroundColor: colors.accent },
  dotMock: { backgroundColor: colors.muted },
  chipText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.sm },
  caret: { color: colors.muted, fontSize: type.xs },
  list: { gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelSunken, padding: space.md },
  option: { borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  optionActive: { borderColor: colors.accent, backgroundColor: colors.panelRaised },
  optionDisabled: { opacity: 0.4 },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  optionLabel: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.md },
  activeTag: { color: colors.accent, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.8 },
  optionDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.xs },
  warning: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.xs },
  pressed: { opacity: 0.65 },
});
