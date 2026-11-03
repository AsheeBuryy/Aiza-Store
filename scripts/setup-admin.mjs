import { upsertAdminAccount } from "./admin-account.mjs";

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const username = process.env.ADMIN_USERNAME?.trim();
const password = process.env.ADMIN_PASSWORD;

if (!supabaseUrl || !serviceKey || !username || !password) {
  throw new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_USERNAME, and ADMIN_PASSWORD in .env.setup.");
}

await upsertAdminAccount({ supabaseUrl, serviceKey, username, password });
console.log(`Supabase admin account configured for username "${username}".`);
console.log("Remove .env.setup now. Never publish or share its service-role key or admin password.");
