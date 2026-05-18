/** Currency decimal places for minor-unit math (matches storefront / pricing). */
const CURRENCY_DECIMALS_OVERRIDES: Record<string, number> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

export function inferCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.toUpperCase();
  return CURRENCY_DECIMALS_OVERRIDES[normalized] ?? 2;
}

export function moneyScale(decimals: number): number {
  return 10 ** decimals;
}
