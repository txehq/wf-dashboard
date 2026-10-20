import { CURRENCIES } from './currencies.js';

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format an amount expressed in minor units (e.g. cents) for display.
 *
 *   formatMoney(123456, 'USD')  // => '$1,234.56'
 *   formatMoney(1234, 'JPY')    // => '¥1,234'
 *   formatMoney(-1999, 'USD')   // => '-$19.99'
 */
export function formatMoney(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`amountMinor must be a safe integer, got ${String(amountMinor)}`);
  }
  if (!Object.hasOwn(CURRENCIES, currency)) {
    throw new RangeError(`Unsupported currency: ${String(currency)}`);
  }
  const { symbol, decimals } = CURRENCIES[currency];
  const sign = amountMinor < 0 ? '-' : '';
  // Split the digits as a string so large amounts never go through floating-point division.
  const digits = String(Math.abs(amountMinor)).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const number = decimals === 0 ? groupThousands(whole) : `${groupThousands(whole)}.${fraction}`;
  return `${sign}${symbol}${number}`;
}
