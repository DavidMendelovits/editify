import { useState, type PropsWithChildren } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient as SvgGradient, Stop, Text as SvgText } from 'react-native-svg';
import type { PurchasesPackage } from 'react-native-purchases';
import { Button } from '../src/components/Button';
import { LegalLinks } from '../src/components/LegalLinks';
import { Screen } from '../src/components/Screen';
import { PLAN_FEATURES, bigPrice, tierOfPackage } from '../src/lib/plan-display';
import {
  billingAvailable, buy, getPlans, hasFreeTrial, priceLabel, restore, usePurchasesReady, useTier, userCancelled, type Plan,
} from '../src/lib/purchases';
import { track } from '../src/lib/telemetry';
import { brand, colors, radius, space, type, fonts } from '../src/lib/theme';

const GRADIENT = [brand.gradientFrom, brand.gradientTo] as const;
const PRICE_SIZE = 56;
const PRICE_LINE = 64;

export default function PaywallScreen() {
  const router = useRouter();
  const tier = useTier();
  const ready = usePurchasesReady();
  const [error, setError] = useState<string>();
  const plans = useQuery({ queryKey: ['plans'], queryFn: getPlans, staleTime: 5 * 60_000 });
  // Only promise a trial the store will actually give this account.
  const trial = plans.data?.some(hasFreeTrial) ?? false;

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

  // Until the store user is this account, a purchase or restore would land on the last one.
  const busy = purchase.isPending || restoring.isPending || !ready;

  return (
    <Screen header={
      <View style={styles.header}>
        <Text style={styles.kicker}>EDITIFY SUBSCRIPTION</Text>
        <Button secondary style={styles.close} accessibilityLabel="close" onPress={() => router.back()}>close</Button>
      </View>
    }>
      <View style={styles.hero}>
        <Text style={styles.title}>Cut without the ceiling</Text>
        <Text style={styles.body}>
          {trial
            ? 'Start with a free trial. Cancel any time before it ends and you are not charged.'
            : 'Pick a plan and cancel any time in your store account.'}
        </Text>
      </View>

      {!billingAvailable && (
        <View style={styles.notice}><Text style={styles.body}>Subscriptions are only available in the Editify app on iOS and Android.</Text></View>
      )}
      {plans.isLoading && <Text style={styles.body}>Loading plans…</Text>}
      {plans.error && <Text style={styles.error}>Could not reach the store: {plans.error.message}</Text>}
      {billingAvailable && plans.data?.length === 0 && (
        <Text style={styles.error}>No plans are available on this account yet.</Text>
      )}

      <View style={styles.plans}>
        <PlanCard name="Free" features={PLAN_FEATURES.free} amount="$0" period="/ forever" current={tier === 'free'} />
        {plans.data?.map((plan) => (
          <PackageCard
            key={plan.pkg.identifier}
            plan={plan}
            current={tier !== 'free' && tier === tierOfPackage(plan.pkg.identifier)}
            busy={busy}
            opening={purchase.isPending}
            onBuy={() => purchase.mutate(plan.pkg)}
          />
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {tier !== 'free' && <Text style={styles.body}>You are on the {tier} plan. Manage or cancel it in your App Store account.</Text>}

      <View style={styles.footer}>
        <Button secondary disabled={busy || !billingAvailable} accessibilityLabel="restore purchases" onPress={() => restoring.mutate()}>
          {restoring.isPending ? 'restoring…' : 'restore purchases'}
        </Button>
        <Text style={styles.legal}>
          {trial ? 'The trial converts to a paid subscription unless you cancel at least 24 hours before it ends. ' : ''}
          Payment is charged to your store account and renews until you cancel it there.
        </Text>
        <LegalLinks />
      </View>
    </Screen>
  );
}

/** A store package drawn as a card: name and price from the store, features from us. */
function PackageCard({ plan, current, busy, opening, onBuy }: {
  plan: Plan; current: boolean; busy: boolean; opening: boolean; onBuy: () => void;
}) {
  const { pkg, introEligible } = plan;
  const planTier = tierOfPackage(pkg.identifier);
  const { amount, period } = bigPrice(pkg.product.priceString, pkg.product.subscriptionPeriod);
  return (
    <PlanCard
      name={pkg.product.title}
      features={planTier ? PLAN_FEATURES[planTier] : [pkg.product.description].filter(Boolean)}
      amount={amount}
      period={period}
      featured={planTier === 'creator'}
      current={current}
      {...(introEligible && pkg.product.introPrice ? { trialLine: priceLabel(pkg, true) } : {})}
    >
      {!current && (
        <Button disabled={busy} accessibilityLabel={`subscribe to ${pkg.product.title}`} onPress={onBuy}>
          {opening ? 'opening the store…' : hasFreeTrial(plan) ? 'start free trial' : 'subscribe'}
        </Button>
      )}
    </PlanCard>
  );
}

function PlanCard({ name, amount, period, features, trialLine, featured = false, current, children }: PropsWithChildren<{
  name: string; amount: string; period: string; features: string[]; trialLine?: string; featured?: boolean; current: boolean;
}>) {
  const body = (
    <View style={[styles.card, featured && styles.cardFeatured]}>
      <Text style={styles.planName}>{name}</Text>
      <View style={styles.priceRow}>
        {featured ? <GradientText style={styles.price}>{amount}</GradientText> : <Text style={styles.price}>{amount}</Text>}
        <Text style={styles.period}> {period}</Text>
      </View>
      {trialLine && <Text style={styles.trial}>{trialLine}</Text>}
      <View style={styles.divider} />
      {features.map((feature) => (
        <View key={feature} style={styles.feature}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.featureText}>{feature}</Text>
        </View>
      ))}
      {current && <Text style={styles.current}>current plan</Text>}
      {children}
    </View>
  );
  if (!featured) return <View style={styles.cell}>{body}</View>;
  return (
    <View style={[styles.cell, styles.featuredCell]}>
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradientBorder}>{body}</LinearGradient>
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.pill}>
        <Text style={styles.pillText}>MOST POPULAR</Text>
      </LinearGradient>
    </View>
  );
}

/**
 * Text filled with the brand gradient. The plain Text lays out (and stays the
 * accessible label); the SVG copy is drawn over it once its size is known.
 */
function GradientText({ children, style }: { children: string; style: typeof styles.price }) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  return (
    <View>
      <Text style={[style, size && styles.hidden]} onLayout={(event) => setSize(event.nativeEvent.layout)}>{children}</Text>
      {size && (
        <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <SvgGradient id="price" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={brand.gradientFrom} />
              <Stop offset="1" stopColor={brand.gradientTo} />
            </SvgGradient>
          </Defs>
          <SvgText fill="url(#price)" fontFamily={style.fontFamily} fontSize={style.fontSize} x={0} y={size.height * 0.8}>{children}</SvgText>
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xl },
  close: { flexShrink: 0, minHeight: 32, paddingHorizontal: space.xl },
  kicker: { flexShrink: 1, color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.6 },
  hero: { paddingTop: space.section, gap: space.lg, maxWidth: 1000, width: '100%', alignSelf: 'center' },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: type.display, letterSpacing: -1 },
  body: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  notice: { borderRadius: brand.cardRadius, borderWidth: 1, borderColor: brand.border, backgroundColor: brand.panel, padding: space.section, maxWidth: 1000, width: '100%', alignSelf: 'center' },
  // Phones stack full width; from ~700pt the cards sit side by side.
  plans: { flexDirection: 'row', flexWrap: 'wrap', gap: space.section, maxWidth: 1000, width: '100%', alignSelf: 'center' },
  cell: { flexGrow: 1, flexBasis: 280, minWidth: 0 },
  // Room above the card for the pill that straddles its top edge.
  featuredCell: {
    marginTop: space.section,
    shadowColor: brand.gradientFrom, shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
  },
  gradientBorder: { flexGrow: 1, borderRadius: brand.cardRadius, padding: 1.5 },
  card: {
    flexGrow: 1, gap: space.xl, borderRadius: brand.cardRadius, borderWidth: 1, borderColor: brand.border,
    backgroundColor: brand.panel, padding: space.section + space.md,
  },
  cardFeatured: { borderWidth: 0, borderRadius: brand.cardRadius - 1.5 },
  pill: { position: 'absolute', top: -12, alignSelf: 'center', borderRadius: radius.full, paddingHorizontal: space.xxl, paddingVertical: space.md },
  pillText: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.md, letterSpacing: 1.2 },
  planName: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.display },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap' },
  price: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: PRICE_SIZE, lineHeight: PRICE_LINE, letterSpacing: -1 },
  hidden: { opacity: 0 },
  period: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.xxl, paddingBottom: space.lg },
  trial: { color: colors.accent, fontFamily: fonts.semibold, fontSize: type.lg },
  divider: { height: 1, backgroundColor: brand.border, marginVertical: space.sm },
  feature: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  check: { color: brand.check, fontSize: type.xxl, fontWeight: '700' },
  featureText: { color: brand.text, fontFamily: fonts.regular, fontSize: type.xl },
  current: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2, textTransform: 'uppercase' },
  footer: { gap: space.xl, maxWidth: 1000, width: '100%', alignSelf: 'center' },
  legal: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 15 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
