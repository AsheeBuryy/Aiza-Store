import { randomBytes, scryptSync } from "node:crypto";

export function hashAdminPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export function validateAdminCredentials(username, password) {
  if (!username || username.length > 80 || password.length < 12) {
    throw new Error("Use an admin username up to 80 characters and a password of at least 12 characters.");
  }
}

export async function upsertAdminAccount({ supabaseUrl, serviceKey, username, password }) {
  validateAdminCredentials(username, password);
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/admin_users?on_conflict=username`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ username, password_hash: hashAdminPassword(password) }]),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.error(`Admin account setup failed (HTTP ${response.status}).`);
    throw new Error("Check that you ran the Supabase migration and that the URL and service-role key are correct.");
  }
}
