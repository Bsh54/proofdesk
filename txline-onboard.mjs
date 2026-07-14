// TxLINE onboarding — devnet free World Cup tier
// 1. wallet + airdrop  2. on-chain subscribe (free)  3. activate API token
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, web3 } = anchorPkg;
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFileSync, writeFileSync, existsSync } from "fs";

const NET = process.env.NET || "devnet";
const CFG = {
  devnet: {
    rpc: "https://api.devnet.solana.com",
    api: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    mint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
  },
  mainnet: {
    rpc: "https://api.mainnet-beta.solana.com",
    api: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    mint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
  },
}[NET];

const SERVICE_LEVEL_ID = Number(process.env.SERVICE_LEVEL || 1);
const DURATION_WEEKS = 4;
const KEYFILE = "/opt/proofdesk/data/wallet.json";
const OUTFILE = "/opt/proofdesk/data/txline-credentials.json";

const log = (...a) => console.log("[onboard]", ...a);

// --- 1. wallet ---
let keypair;
if (existsSync(KEYFILE)) {
  keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYFILE, "utf8"))));
  log("wallet loaded:", keypair.publicKey.toBase58());
} else {
  keypair = Keypair.generate();
  writeFileSync(KEYFILE, JSON.stringify(Array.from(keypair.secretKey)));
  log("wallet created:", keypair.publicKey.toBase58());
}

const connection = new Connection(CFG.rpc, "confirmed");
let balance = await connection.getBalance(keypair.publicKey);
log("balance:", balance / LAMPORTS_PER_SOL, "SOL");

if (NET === "devnet" && balance < 0.05 * LAMPORTS_PER_SOL) {
  log("requesting devnet airdrop…");
  try {
    const sig = await connection.requestAirdrop(keypair.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    balance = await connection.getBalance(keypair.publicKey);
    log("airdrop ok, balance:", balance / LAMPORTS_PER_SOL, "SOL");
  } catch (e) {
    log("airdrop failed (rate limit?):", e.message);
    if (balance === 0) { log("FATAL: no SOL. Use https://faucet.solana.com for", keypair.publicKey.toBase58()); process.exit(1); }
  }
}

// --- 2. on-chain subscribe ---
const wallet = new Wallet(keypair);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

log("fetching IDL on-chain…");
const idl = await Program.fetchIdl(CFG.programId, provider);
if (!idl) { log("FATAL: IDL not published on-chain. Need IDL from docs."); process.exit(1); }
writeFileSync("/opt/proofdesk/data/txline-idl.json", JSON.stringify(idl, null, 2));
log("IDL ok:", idl.name || idl.metadata?.name, "— instructions:", idl.instructions.map((i) => i.name).join(", "));

const program = new Program(idl, provider);

// derive PDAs (try common seed conventions; adjust from IDL accounts if needed)
const findPda = (seeds) => PublicKey.findProgramAddressSync(seeds, CFG.programId)[0];
const enc = (s) => Buffer.from(s);
let pricingMatrixPda, tokenTreasuryPda, tokenTreasuryVault;
try {
  // Inspect IDL account PDA definitions if present
  const subIx = idl.instructions.find((i) => i.name === "subscribe");
  log("subscribe accounts:", subIx.accounts.map((a) => a.name).join(", "));
  pricingMatrixPda = findPda([enc("pricing_matrix")]);
  tokenTreasuryPda = findPda([enc("token_treasury_v2")]); // seed confirmed in official examples repo
  tokenTreasuryVault = getAssociatedTokenAddressSync(CFG.mint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
} catch (e) { log("PDA derivation note:", e.message); }

const userTokenAccount = getAssociatedTokenAddressSync(CFG.mint, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);

// Ensure the user's TxL token account exists (level 1 is free, but the
// account itself must be initialized).
log("ensuring user token account exists:", userTokenAccount.toBase58());
const ataIx = createAssociatedTokenAccountIdempotentInstruction(
  keypair.publicKey, userTokenAccount, keypair.publicKey, CFG.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
);
await sendAndConfirmTransaction(connection, new Transaction().add(ataIx), [keypair], { commitment: "confirmed" });
log("token account ready");

log("subscribing: level", SERVICE_LEVEL_ID, "for", DURATION_WEEKS, "weeks…");
let txSig;
try {
  txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: keypair.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: CFG.mint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  log("subscribe tx:", txSig);
} catch (e) {
  log("subscribe FAILED:", e.message);
  log("IDL saved to data/txline-idl.json — inspect accounts/seeds and retry.");
  process.exit(1);
}

// --- 3. activate API token ---
log("getting guest JWT…");
const jwtRes = await fetch(`${CFG.api}/auth/guest/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const { token: jwt } = await jwtRes.json();
log("guest JWT ok");

const messageString = `${txSig}::${jwt}`;
const signatureBytes = nacl.sign.detached(new TextEncoder().encode(messageString), keypair.secretKey);
const walletSignature = Buffer.from(signatureBytes).toString("base64");

log("activating API token…");
const actRes = await fetch(`${CFG.api}/api/token/activate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ txSig, walletSignature, leagues: [] }),
});
const actBody = await actRes.text();
log("activation response:", actRes.status, actBody.slice(0, 400));

let apiToken;
try { const p = JSON.parse(actBody); apiToken = p.token || p.apiToken || (typeof p === "string" ? p : null); } catch { if (actRes.ok && actBody.length < 500) apiToken = actBody.trim(); }
if (!apiToken) { log("FATAL: no apiToken in response"); process.exit(1); }

writeFileSync(OUTFILE, JSON.stringify({ net: NET, api: CFG.api, wallet: keypair.publicKey.toBase58(), txSig, jwt, apiToken, createdAt: new Date().toISOString() }, null, 2));
log("SUCCESS — credentials saved to", OUTFILE);

// quick data test
const test = await fetch(`${CFG.api}/api/fixtures`, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } });
log("fixtures test:", test.status, (await test.text()).slice(0, 300));
