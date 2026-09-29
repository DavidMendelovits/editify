import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchasesPackage } from 'react-native-purchases';

// A fake RevenueCat: entitlements follow whichever user the SDK is logged in as.
const sdk = vi.hoisted(() => {
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = 'appl_test';
  const state = { user: '$anon', entitlements: {} as Record<string, string[]>, gate: undefined as Promise<void> | undefined };
  const info = () => ({ entitlements: { active: Object.fromEntries((state.entitlements[state.user] ?? []).map((id) => [id, {}])) } });
  return {
    state,
    configure: vi.fn(({ appUserID }: { appUserID?: string }) => { state.user = appUserID ?? '$anon'; }),
    addCustomerInfoUpdateListener: vi.fn(),
    logIn: vi.fn(async (id: string) => { await state.gate; state.user = id; }),
    logOut: vi.fn(async () => { state.user = '$anon'; }),
    getCustomerInfo: vi.fn(async () => info()),
    getOfferings: vi.fn(),
    checkTrialOrIntroductoryPriceEligibility: vi.fn(),
  };
});

vi.mock('react-native', () => ({ Platform: { select: (options: { ios?: unknown }) => options.ios } }));
vi.mock('react-native-purchases', () => ({
  default: sdk,
  INTRO_ELIGIBILITY_STATUS: {
    INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0,
    INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1,
    INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2,
    INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3,
  },
}));

const { currentTier, getPlans, hasFreeTrial, priceLabel, purchasesReady, syncPurchaseUser } = await import('./purchases');

type Intro = { price: number; priceString: string; cycles: number; periodUnit: string; periodNumberOfUnits: number };
function pkg(identifier: string, price: number, introPrice?: Intro, subscriptionPeriod = 'P1M'): PurchasesPackage {
  return {
    identifier,
    product: { identifier, price, priceString: `€${price.toFixed(2)}`, subscriptionPeriod, introPrice: introPrice ?? null },
  } as unknown as PurchasesPackage;
}
const freeWeek: Intro = { price: 0, priceString: '€0.00', cycles: 1, periodUnit: 'WEEK', periodNumberOfUnits: 1 };

describe('priceLabel', () => {
  it('promises a free trial only to an account that can still get it', () => {
    expect(priceLabel(pkg('pro', 12, freeWeek), true)).toBe('1 week free, then €12.00/month');
    expect(priceLabel(pkg('pro', 12, freeWeek), false)).toBe('€12.00/month');
  });

  it('shows a paid intro instead of dropping it', () => {
    const upFront: Intro = { price: 1, priceString: '€1.00', cycles: 1, periodUnit: 'MONTH', periodNumberOfUnits: 1 };
    const perMonth: Intro = { price: 1, priceString: '€1.00', cycles: 3, periodUnit: 'MONTH', periodNumberOfUnits: 1 };
    expect(priceLabel(pkg('pro', 12, upFront), true)).toBe('€1.00 for 1 month, then €12.00/month');
    expect(priceLabel(pkg('pro', 12, perMonth), true)).toBe('€1.00/month for 3 months, then €12.00/month');
    expect(priceLabel(pkg('pro', 12, perMonth), false)).toBe('€12.00/month');
  });

  it('shows the plain price when there is no intro offer', () => {
    expect(priceLabel(pkg('studio', 99, undefined, 'P1Y'), true)).toBe('€99.00/year');
  });
});

describe('getPlans', () => {
  beforeEach(() => {
    sdk.getOfferings.mockResolvedValue({ current: { availablePackages: [pkg('studio', 30, freeWeek), pkg('pro', 12, freeWeek)] } });
  });

  it('sorts cheapest first and treats anything but "eligible" as no trial', async () => {
    sdk.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({ pro: { status: 2 }, studio: { status: 0 } });
    const plans = await getPlans();
    expect(plans.map((plan) => [plan.pkg.identifier, plan.introEligible, hasFreeTrial(plan)])).toEqual([
      ['pro', true, true],
      ['studio', false, false],
    ]);
  });

  it('still lists the plans when the eligibility check fails', async () => {
    sdk.checkTrialOrIntroductoryPriceEligibility.mockRejectedValue(new Error('offline'));
    expect((await getPlans()).map((plan) => plan.introEligible)).toEqual([false, false]);
  });
});

describe('syncPurchaseUser', () => {
  // One module, one SDK: these run in order and build on each other.
  it('configures once for the first user and marks the store ready', async () => {
    sdk.state.entitlements = { alice: ['pro'], bob: ['studio'] };
    await syncPurchaseUser('alice');
    expect(sdk.configure).toHaveBeenCalledTimes(1);
    expect(currentTier()).toBe('pro');
    expect(purchasesReady()).toBe(true);
  });

  it('drops to free at once on a user change and runs queued changes one at a time', async () => {
    let open = (): void => {};
    sdk.state.gate = new Promise<void>((resolve) => { open = resolve; });
    const toBob = syncPurchaseUser('bob');
    // Alice's tier is gone before the store answers, and buying waits.
    expect(currentTier()).toBe('free');
    expect(purchasesReady()).toBe(false);
    const signedOut = syncPurchaseUser(undefined);
    await Promise.resolve();
    expect(sdk.logIn).toHaveBeenCalledWith('bob');
    expect(sdk.logOut).not.toHaveBeenCalled();

    open();
    await toBob;
    // Bob's studio arrived after he had already signed out: it must not show.
    expect(currentTier()).toBe('free');
    await signedOut;
    expect(sdk.logOut).toHaveBeenCalledTimes(1);
    expect(currentTier()).toBe('free');
    expect(purchasesReady()).toBe(true);
    sdk.state.gate = undefined;
  });

  it('swallows a failed login, leaving the tier free and buying disabled', async () => {
    sdk.logIn.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(syncPurchaseUser('bob')).resolves.toBeUndefined();
    expect(currentTier()).toBe('free');
    expect(purchasesReady()).toBe(false);
    warn.mockRestore();

    // The next session event retries and lands.
    await syncPurchaseUser('bob');
    expect(currentTier()).toBe('studio');
    expect(purchasesReady()).toBe(true);
  });
});
