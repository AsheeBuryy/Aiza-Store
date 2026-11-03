import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { upsertAdminAccount, validateAdminCredentials } from "./admin-account.mjs";

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const username = process.env.ADMIN_USERNAME?.trim();
const password = process.env.ADMIN_PASSWORD;
const storePath = resolve(process.env.STORE_JSON_PATH ?? "storage/store.json");
const seedPath = resolve("backend/seed.json");

if (!supabaseUrl || !serviceKey || !username || !password) {
  throw new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_USERNAME, and ADMIN_PASSWORD in .env.setup.");
}
validateAdminCredentials(username, password);

async function request(path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.error(`Database setup failed while writing ${path.split("?")[0]} (HTTP ${response.status}).`);
    throw new Error("Check that you ran the Supabase migration and that the URL and service-role key are correct.");
  }
}

const dataPath = existsSync(storePath) ? storePath : seedPath;
const state = JSON.parse(readFileSync(dataPath, "utf8"));
if (!Array.isArray(state.products) || !Array.isArray(state.transactions)) {
  throw new Error("The selected store data file must contain products and transactions arrays.");
}

if (state.products.length) {
  await request("store_products?on_conflict=id", {
    method: "POST",
    body: state.products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category || "Uncategorized",
      price: Number(product.price),
      stock: Number(product.stock),
      emoji: product.emoji || "🛒",
      description: product.description || "An everyday store favorite.",
    })),
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

if (state.transactions.length) {
  const transactions = state.transactions.map((transaction) => ({
    id: transaction.id,
    checkout_id: transaction.checkout_id ?? null,
    type: transaction.type,
    status: transaction.status,
    amount: Number(transaction.amount),
    description: transaction.description,
    payment_method: transaction.payment_method,
    items: Array.isArray(transaction.items) ? transaction.items : [],
    created_at: transaction.created_at,
    confirmed_at: transaction.confirmed_at ?? null,
    cancelled_at: transaction.cancelled_at ?? null,
  }));
  await request("store_transactions?on_conflict=id", {
    method: "POST",
    body: transactions,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

await upsertAdminAccount({ supabaseUrl, serviceKey, username, password });

console.log(`Database setup complete. Imported ${state.products.length} products and ${state.transactions.length} transactions; configured the admin account.`);
console.log("Remove .env.setup now. Never publish or share its service-role key or admin password.");
