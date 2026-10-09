/**
 * What the wallet signs for each business step. Shared by the browser (which
 * asks the wallet to sign it) and the server (which rebuilds it to verify), so it
 * lives apart from the server-only business code. Wallets show the text in
 * full, so it says exactly what it approves.
 */

export function businessMessage(action: string, wallet: string, time: string): string {
  return `SigPath business verification\nAction: ${action}\nWallet: ${wallet}\nTime: ${time}`;
}

export const vatAction = (country: string, number: string) => `check VAT number ${country}${number}`;
export const domainAction = (domain: string) => `prove website ${domain}`;
