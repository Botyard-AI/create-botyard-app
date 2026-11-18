const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" })

/** 1234.5 → "€1,234.50". Used by the UI and by what the server writes for people. */
export const eur = (n: number): string => money.format(n)
