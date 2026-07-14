// List TxLINE service levels from the on-chain pricing matrix (devnet)
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/opt/proofdesk/data/wallet.json", "utf8"))));
const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: "confirmed" });
const programId = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const idl = JSON.parse(readFileSync("/opt/proofdesk/data/txline-idl.json", "utf8"));
const program = new Program(idl, provider);

const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], programId);
const matrix = await program.account.pricingMatrix.fetch(pda);
console.log(JSON.stringify(matrix, (k, v) => (typeof v === "bigint" ? v.toString() : v && v.toNumber ? v.toNumber() : v), 1).slice(0, 4000));
