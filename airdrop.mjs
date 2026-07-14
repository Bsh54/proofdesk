// Multi-faucet devnet airdrop with retries
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/opt/proofdesk/data/wallet.json", "utf8"))));
const pub = keypair.publicKey;
console.log("wallet:", pub.toBase58());

const RPCS = [
  "https://api.devnet.solana.com",
  "https://devnet.helius-rpc.com/?api-key=public",
  "https://rpc.ankr.com/solana_devnet",
];

const amounts = [1, 0.5, 0.2];
for (const rpc of RPCS) {
  const conn = new Connection(rpc, "confirmed");
  let bal;
  try { bal = await conn.getBalance(pub); } catch { continue; }
  console.log(`[${rpc.slice(8, 30)}] balance: ${bal / LAMPORTS_PER_SOL} SOL`);
  if (bal >= 0.05 * LAMPORTS_PER_SOL) { console.log("ENOUGH — done"); process.exit(0); }
  for (const amt of amounts) {
    try {
      console.log(`  trying airdrop ${amt} SOL via ${rpc.slice(8, 30)}…`);
      const sig = await conn.requestAirdrop(pub, amt * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      const nb = await conn.getBalance(pub);
      console.log("  SUCCESS — balance:", nb / LAMPORTS_PER_SOL, "SOL");
      process.exit(0);
    } catch (e) {
      console.log("  fail:", e.message.slice(0, 80));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
console.log("ALL FAUCETS FAILED — manual faucet needed: https://faucet.solana.com →", pub.toBase58());
process.exit(1);
