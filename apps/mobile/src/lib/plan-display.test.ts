import { describe, expect, it } from 'vitest';
import { bigPrice, tierOfPackage } from './plan-display';

describe('bigPrice', () => {
  it('drops zero cents in either decimal style', () => {
    expect(bigPrice('$12.00', 'P1M')).toEqual({ amount: '$12', period: '/ month' });
    expect(bigPrice('12,00 €', 'P1M')).toEqual({ amount: '12 €', period: '/ month' });
    expect(bigPrice('$1,000.00', 'P1Y')).toEqual({ amount: '$1,000', period: '/ year' });
    expect(bigPrice('1.000,00 €', 'P1W')).toEqual({ amount: '1.000 €', period: '/ week' });
  });

  it('keeps real cents and thousands groups', () => {
    expect(bigPrice('$11.99', 'P1M').amount).toBe('$11.99');
    expect(bigPrice('¥1,200', 'P1M').amount).toBe('¥1,200');
    expect(bigPrice('$10.50', null)).toEqual({ amount: '$10.50', period: '/ month' });
  });
});

describe('tierOfPackage', () => {
  it('maps the RevenueCat packages and nothing else', () => {
    expect(tierOfPackage('creator_monthly')).toBe('creator');
    expect(tierOfPackage('studio_monthly')).toBe('studio');
    expect(tierOfPackage('$rc_monthly')).toBeUndefined();
  });
});
