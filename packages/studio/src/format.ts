// A monthly figure as the studio prints it, on both surfaces. Kept free of
// imports: the dashboard bundles this module.
export const money = (amount: number) => `$${amount.toFixed(2)}`;
