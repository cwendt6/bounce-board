/**
 * Browser side of a takeover: connect the wallet, sign the x402 USDC authorization, and
 * retry POST /api/take with the PAYMENT-SIGNATURE header. Loaded only when a buyer clicks
 * "Take the box", so the wallet libraries stay out of the main bundle.
 *
 * The wallet signs an EIP-3009 transferWithAuthorization for exactly the quoted amount.
 * The facilitator submits it on-chain; the buyer needs USDC, not ETH for gas.
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { type Chain, createWalletClient, custom, type EIP1193Provider } from "viem";
import { base, baseSepolia } from "viem/chains";

const CHAINS: Record<string, Chain> = { "eip155:84532": baseSepolia, "eip155:8453": base };

export interface TakeCardInput {
  name: string;
  description: string;
  link: string;
  x?: string;
  ticker?: string;
  chain?: string;
  contract?: string;
}

export class TakeError extends Error {}

type Status = (msg: string) => void;

function provider(): EIP1193Provider {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth)
    throw new TakeError("No wallet found. Install Coinbase Wallet or MetaMask, then try again.");
  return eth;
}

async function ensureChain(eth: EIP1193Provider, chain: Chain) {
  const hex = `0x${chain.id.toString(16)}` as const;
  const current = await eth.request({ method: "eth_chainId" });
  if (current === hex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string; errors?: string[] } | null;
  return body?.errors?.join(". ") ?? body?.error ?? `Request failed (${res.status})`;
}

export async function takeTheBox(
  apiUrl: string,
  card: TakeCardInput,
  status: Status,
): Promise<{ tx: string }> {
  const body = JSON.stringify(card);
  const headers = { "Content-Type": "application/json" };

  status("Getting the price…");
  const quote = await fetch(apiUrl, { method: "POST", headers, body });
  if (quote.status !== 402) throw new TakeError(await errorText(quote));
  const quoteBody = await quote.json().catch(() => undefined);

  const eth = provider();
  status("Connect your wallet…");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  if (!address) throw new TakeError("No wallet account selected.");

  const http = new x402HTTPClient(new x402Client());
  const required = http.getPaymentRequiredResponse((h) => quote.headers.get(h), quoteBody);
  if (required.accepts.some((a) => a.payTo.toLowerCase() === address.toLowerCase())) {
    throw new TakeError(
      "This wallet is the board's receiving wallet. Switch to a different account in your wallet and try again.",
    );
  }
  const network = required.accepts[0]?.network;
  const chain = CHAINS[network];
  if (!chain) throw new TakeError(`Unsupported payment network: ${network}`);
  await ensureChain(eth, chain);

  const wallet = createWalletClient({ account: address, chain, transport: custom(eth) });
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: {
      address,
      signTypedData: (m) =>
        wallet.signTypedData({
          account: address,
          domain: m.domain,
          types: m.types,
          primaryType: m.primaryType,
          message: m.message,
        } as Parameters<typeof wallet.signTypedData>[0]),
    },
  });
  const payer = new x402HTTPClient(client);

  status("Approve the $1 USDC payment in your wallet…");
  const slow = window.setTimeout(
    () =>
      status(
        "Still waiting for your wallet. If its window is stuck, close it, reload this page and try again.",
      ),
    30_000,
  );
  let payload: Awaited<ReturnType<typeof payer.createPaymentPayload>>;
  try {
    payload = await payer.createPaymentPayload(required);
  } finally {
    window.clearTimeout(slow);
  }

  status("Settling payment…");
  const paid = await fetch(apiUrl, {
    method: "POST",
    headers: { ...headers, ...payer.encodePaymentSignatureHeader(payload) },
    body,
  });
  if (paid.status !== 201) throw new TakeError(await errorText(paid));
  const result = (await paid.json()) as { tx: string };
  return { tx: result.tx };
}
