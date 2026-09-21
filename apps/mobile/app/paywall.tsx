import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { billingAvailable, buy, getPackages, priceLabel, restore, useTier, userCancelled } from '../src/lib/purchases';
import { track } from '../src/lib/telemetry';
import { colors, radius, space, type, fonts } from '../src/lib/theme';

export default function PaywallScreen() {
  const router = useRouter();
  const tier = useTier();
  const [error, setError] = useState<string>();
  const packages = useQuery({ queryKey: ['packages'], queryFn: getPackages, staleTime: 5 * 60_000 });

  const purchase = useMutation({
    mutationFn: (pkg: PurchasesPackage) => buy(pkg),
    onMutate: () => setError(undefined),
    onSuccess: (next) => { track('subscribe', next); router.back(); },
    onError: (cause) => { if (!userCancelled(cause)) setError(cause instanceof Error ? cause.message : String(cause)); },
  });

  const restoring = useMutation({
    mutationFn: restore,
    onMutate: () => setError(undefined),
    onSuccess: (next) => setError(next === 'free' ? 'No subscription found on this account.' : undefined),
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });

  const busy = purchase.isPending || restoring.isPending;

  return (
    <Screen header={
      <View style={styles.header}>
        <Text style={styles.kicker}>EDITIFY SUBSCRIPTION</Text>
        <Button secondary style={styles.close} accessibilityLabel="close" onPress={() => router.back()}>close</Button>
      </View>
    }>
      <View style={styles.hero}>
        <Text style={styles.title}>Cut without the ceiling</Text>
        <Text style={styles.body}>Every plan starts with a 7-day free trial. Cancel any time before it ends and you are not charged.</Text>
      </View>

      {!billingAvailable && (
        <View style={styles.card}><Text style={styles.body}>Subscriptions are only available in the Editify app on iOS and Android.</Text></View>
      )}
      {packages.isLoading && <Text style={styles.body}>Loading plans…</Text>}
      {packages.error && <Text style={styles.error}>Could not reach the store: {packages.error.message}</Text>}
      {billingAvailable && packages.data?.length === 0 && (
        <Text style={styles.error}>No plans are available on this account yet.</Text>
      )}

      <View style={styles.plans}>
        {packages.data?.map((pkg) => (
          <View key={pkg.identifier} style={styles.card}>
            <Text style={styles.planName}>{pkg.product.title}</Text>
            <Text style={styles.price}>{priceLabel(pkg)}</Text>
            {!!pkg.product.description && <Text style={styles.body}>{pkg.product.description}</Text>}
            <Button
              disabled={busy}
              accessibilityLabel={`subscribe to ${pkg.product.title}`}
              onPress={() => purchase.mutate(pkg)}
            >
              {purchase.isPending ? 'opening the store…' : 'start free trial'}
            </Button>
          </View>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {tier !== 'free' && <Text style={styles.body}>You are on the {tier} plan. Manage or cancel it in your App Store account.</Text>}

      <View style={styles.footer}>
        <Button secondary disabled={busy || !billingAvailable} accessibilityLabel="restore purchases" onPress={() => restoring.mutate()}>
          {restoring.isPending ? 'restoring…' : 'restore purchases'}
        </Button>
        <Text style={styles.legal}>
          The trial converts to a paid subscription unless you cancel at least 24 hours before it ends. Payment is charged to your store
          account and renews until you cancel it there.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xl },
  close: { minHeight: 32, paddingHorizontal: space.xl },
  kicker: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.6 },
  hero: { paddingTop: space.section, gap: space.lg, maxWidth: 900, width: '100%', alignSelf: 'center' },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: type.display, letterSpacing: -1 },
  body: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  plans: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xl, maxWidth: 900, width: '100%', alignSelf: 'center' },
  card: { flexGrow: 1, flexBasis: 260, gap: space.xl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.section },
  planName: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  price: { color: colors.accent, fontFamily: fonts.semibold, fontSize: type.xl },
  footer: { gap: space.xl, maxWidth: 900, width: '100%', alignSelf: 'center' },
  legal: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 15 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
