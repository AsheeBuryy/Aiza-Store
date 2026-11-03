import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { handler } from "../netlify/functions/api.mjs";
import { hashAdminPassword, upsertAdminAccount } from "../scripts/admin-account.mjs";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  PAYMONGO_SECRET_KEY: process.env.PAYMONGO_SECRET_KEY,
};

function jsonResponse(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("products are loaded from Supabase and numeric values are normalized", async () => {
  const requestUrls = [];
  let requestHeaders;
  globalThis.fetch = async (input, options) => {
    const requestUrl = String(input);
    requestUrls.push(requestUrl);
    requestHeaders = options.headers;
    if (new URL(requestUrl).pathname.endsWith("/store_settings")) return jsonResponse([{ value: "09302846922" }]);
    return jsonResponse([{ id: "coffee", name: "Coffee", price: "12.00", stock: 5 }]);
  };

  const result = await handler({
    httpMethod: "GET",
    path: "/.netlify/functions/api",
    queryStringParameters: { action: "products" },
    headers: {},
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    products: [{ id: "coffee", name: "Coffee", price: 12, stock: 5 }],
    gcash_number: "09302846922",
  });
  assert.ok(requestUrls.some((url) => /\/rest\/v1\/store_products\?/.test(url)));
  assert.ok(requestUrls.some((url) => /\/rest\/v1\/store_settings\?/.test(url)));
  assert.equal(requestHeaders.apikey, "server-only-test-key");
});

test("products report missing database configuration as a JSON error", async () => {
  delete process.env.SUPABASE_URL;

  const result = await handler({
    httpMethod: "GET",
    rawUrl: "https://store.example/api.php?action=products",
    headers: {},
  });

  assert.equal(result.statusCode, 503);
  assert.match(JSON.parse(result.body).error, /database is not configured/i);
});

test("cash checkout saves a price-verified order in the database", async () => {
  let inserted;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/store_products")) {
      return jsonResponse([{ id: "coffee", name: "Coffee", price: "12.00", stock: 5 }]);
    }
    if (url.pathname.endsWith("/store_transactions")) {
      inserted = JSON.parse(options.body);
      return jsonResponse(null, 201);
    }
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=checkout",
    headers: { origin: "https://store.example", host: "store.example" },
    body: JSON.stringify({
      payment_method: "cash",
      items: [{ id: "coffee", quantity: 2 }],
    }),
  });

  assert.equal(result.statusCode, 201);
  assert.equal(JSON.parse(result.body).cash_order, true);
  assert.equal(inserted.type, "cash_order");
  assert.equal(inserted.amount, 24);
  assert.deepEqual(inserted.items, [{ id: "coffee", name: "Coffee", quantity: 2, unit_price: 12 }]);
});

test("GCash checkout creates a pending manual transfer order without contacting a payment provider", async () => {
  let inserted;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    requests.push(url.hostname + url.pathname);
    if (url.pathname.endsWith("/store_products")) {
      return jsonResponse([{ id: "coffee", name: "Coffee", price: "12.00", stock: 5 }]);
    }
    if (url.pathname.endsWith("/store_settings")) {
      return jsonResponse([{ value: "09302846922" }]);
    }
    if (url.pathname.endsWith("/store_transactions")) {
      inserted = JSON.parse(options.body);
      return jsonResponse(null, 201);
    }
    throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=checkout",
    headers: { origin: "https://store.example", host: "store.example" },
    body: JSON.stringify({
      payment_method: "gcash",
      items: [{ id: "coffee", quantity: 2 }],
    }),
  });

  assert.equal(result.statusCode, 201);
  const responseBody = JSON.parse(result.body);
  assert.equal(responseBody.manual_gcash_order, true);
  assert.equal(responseBody.reference, inserted.id);
  assert.equal(responseBody.amount, 24);
  assert.equal(responseBody.gcash_number, "09302846922");
  assert.match(responseBody.submission_token, /^[a-f0-9]{64}$/);
  assert.equal(inserted.type, "payment");
  assert.equal(inserted.payment_method, "Manual GCash");
  assert.equal(inserted.description, "GCash transfer (1 items)");
  assert.equal(inserted.amount, 24);
  assert.equal(inserted.gcash_reference, null);
  assert.equal(inserted.receipt_path, null);
  assert.equal(inserted.submission_token_hash, createHash("sha256").update(responseBody.submission_token).digest("hex"));
  assert.ok(!requests.some((request) => request.startsWith("api.paymongo.com")));
});

test("customer GCash receipt submission stores a validated private image and reference", async () => {
  const transactionId = "AIZA-1234567890";
  const submissionToken = "a".repeat(64);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    if (url.pathname.endsWith("/store_transactions") && options.method === "GET") return jsonResponse([{ id: transactionId }]);
    if (url.pathname.endsWith(`/object/gcash-payment-receipts/${transactionId}.png`)) return jsonResponse({ Key: `${transactionId}.png` });
    if (url.pathname.endsWith("/store_transactions") && options.method === "PATCH") return jsonResponse([{ id: transactionId }]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=submit_gcash_payment",
    headers: { origin: "https://store.example", host: "store.example" },
    body: JSON.stringify({
      transaction_id: transactionId,
      submission_token: submissionToken,
      gcash_reference: "1234567890123",
      receipt_data_url: `data:image/png;base64,${png.toString("base64")}`,
    }),
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { success: true });
  const upload = requests.find(({ url }) => url.pathname.includes("/object/gcash-payment-receipts/"));
  assert.equal(upload.options.method, "POST");
  assert.equal(upload.options.headers["Content-Type"], "image/png");
  assert.equal(upload.options.headers["x-upsert"], "true");
  assert.deepEqual(Buffer.from(upload.options.body), png);
  const lookup = requests.find(({ url, options }) => url.pathname.endsWith("/store_transactions") && options.method === "GET");
  assert.equal(lookup.url.searchParams.get("submission_token_hash"), `eq.${createHash("sha256").update(submissionToken).digest("hex")}`);
  const update = requests.find(({ url, options }) => url.pathname.endsWith("/store_transactions") && options.method === "PATCH");
  assert.deepEqual(JSON.parse(update.options.body), {
    gcash_reference: "1234567890123",
    receipt_path: `${transactionId}.png`,
  });
});

test("customer receipt submission rejects a file whose content does not match its image type", async () => {
  const calls = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), method: options.method });
    return jsonResponse([{ id: "AIZA-1234567890" }]);
  };
  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=submit_gcash_payment",
    headers: { origin: "https://store.example", host: "store.example" },
    body: JSON.stringify({
      transaction_id: "AIZA-1234567890",
      submission_token: "a".repeat(64),
      gcash_reference: "12345678",
      receipt_data_url: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
    }),
  });
  assert.equal(result.statusCode, 422);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("admin dashboard returns a signed receipt link without exposing the submission token hash", async () => {
  const token = "b".repeat(64);
  const receiptPath = "AIZA-1234567890.png";
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/admin_sessions")) {
      return jsonResponse([{
        token_hash: createHash("sha256").update(token).digest("hex"),
        csrf_hash: createHash("sha256").update("csrf").digest("hex"),
        username: "AizaStore",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }]);
    }
    if (url.pathname.endsWith("/store_products")) return jsonResponse([]);
    if (url.pathname.endsWith("/store_settings")) return jsonResponse([{ value: "09302846922" }]);
    if (url.pathname.endsWith("/store_transactions")) {
      return jsonResponse([{
        id: "AIZA-1234567890",
        type: "payment",
        status: "pending",
        amount: "12.00",
        description: "GCash transfer",
        payment_method: "Manual GCash",
        created_at: new Date().toISOString(),
        gcash_reference: "1234567890123",
        receipt_path: receiptPath,
        submission_token_hash: "private-token-hash",
      }]);
    }
    if (url.pathname.endsWith(`/object/sign/gcash-payment-receipts/${receiptPath}`)) {
      assert.deepEqual(JSON.parse(options.body), { expiresIn: 3600 });
      return jsonResponse({ signedURL: `/object/sign/gcash-payment-receipts/${receiptPath}?token=signed` });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "GET",
    rawUrl: "https://store.example/api.php?action=admin",
    headers: { cookie: `aiza_store_session=${token}` },
  });
  assert.equal(result.statusCode, 200);
  const order = JSON.parse(result.body).transactions[0];
  assert.equal(order.gcash_reference, "1234567890123");
  assert.equal(order.receipt_required, true);
  assert.equal(order.receipt_url, `https://test-project.supabase.co/storage/v1/object/sign/gcash-payment-receipts/${receiptPath}?token=signed`);
  assert.equal("submission_token_hash" in order, false);
});

test("admin dashboard rejects requests without an authenticated session", async () => {
  const result = await handler({
    httpMethod: "GET",
    rawUrl: "https://store.example/api.php?action=admin",
    headers: {},
  });

  assert.equal(result.statusCode, 401);
  assert.equal(JSON.parse(result.body).error, "Please sign in to manage the store.");
});

test("admin writes require the session CSRF token", async () => {
  const token = "a".repeat(64);
  const calls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/admin_sessions")) {
      return jsonResponse([{
        token_hash: createHash("sha256").update(token).digest("hex"),
        csrf_hash: createHash("sha256").update("expected-csrf").digest("hex"),
        username: "AizaStore",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }]);
    }
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=cash_in",
    headers: {
      origin: "https://store.example",
      host: "store.example",
      cookie: `aiza_store_session=${token}`,
      "x-csrf-token": "wrong-token",
    },
    body: JSON.stringify({ amount: 10, description: "Test" }),
  });

  assert.equal(result.statusCode, 403);
  assert.equal(calls.length, 1);
});

test("authenticated admin actions are written to the database", async () => {
  const token = "c".repeat(64);
  const csrfToken = "d".repeat(64);
  let inserted;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/admin_sessions")) {
      return jsonResponse([{
        token_hash: createHash("sha256").update(token).digest("hex"),
        csrf_hash: createHash("sha256").update(csrfToken).digest("hex"),
        username: "AizaStore",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }]);
    }
    if (url.pathname.endsWith("/store_transactions")) {
      inserted = JSON.parse(options.body);
      return jsonResponse(null, 201);
    }
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=cash_in",
    headers: {
      origin: "https://store.example",
      host: "store.example",
      cookie: `aiza_store_session=${token}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ amount: "12.5", description: "Store cash-in" }),
  });

  assert.equal(result.statusCode, 201);
  assert.equal(inserted.type, "cash_in");
  assert.equal(inserted.amount, 12.5);
  assert.equal(inserted.description, "Store cash-in");
});

test("admin can update the GCash contact number stored for the storefront", async () => {
  const token = "e".repeat(64);
  const csrfToken = "f".repeat(64);
  let savedSetting;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/admin_sessions")) {
      return jsonResponse([{
        token_hash: createHash("sha256").update(token).digest("hex"),
        csrf_hash: createHash("sha256").update(csrfToken).digest("hex"),
        username: "AizaStore",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }]);
    }
    if (url.pathname.endsWith("/store_settings")) {
      savedSetting = JSON.parse(options.body);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Prefer, "resolution=merge-duplicates,return=minimal");
      return jsonResponse(null, 201);
    }
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=update_gcash_number",
    headers: {
      origin: "https://store.example",
      host: "store.example",
      cookie: `aiza_store_session=${token}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ gcash_number: "+63 930-284-6922" }),
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(savedSetting, { key: "gcash_number", value: "09302846922" });
});

test("admin confirms a manual GCash payment through the stock-safe database action", async () => {
  const token = "7".repeat(64);
  const csrfToken = "8".repeat(64);
  let resolution;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/admin_sessions")) {
      return jsonResponse([{
        token_hash: createHash("sha256").update(token).digest("hex"),
        csrf_hash: createHash("sha256").update(csrfToken).digest("hex"),
        username: "AizaStore",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }]);
    }
    if (url.pathname.endsWith("/rpc/store_resolve_gcash_payment")) {
      resolution = JSON.parse(options.body);
      return jsonResponse({ success: true });
    }
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=confirm_gcash_payment",
    headers: {
      origin: "https://store.example",
      host: "store.example",
      cookie: `aiza_store_session=${token}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ transaction_id: "AIZA-1234567890" }),
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(resolution, { p_transaction_id: "AIZA-1234567890", p_paid: true });
});

test("login verifies the stored scrypt hash and creates a database session", async () => {
  const password = "a-private-test-password";
  const passwordHash = hashAdminPassword(password);
  const calls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.pathname.endsWith("/rpc/store_record_login_attempt")) return jsonResponse(true);
    if (url.pathname.endsWith("/admin_users")) return jsonResponse([{ username: "AizaStore", password_hash: passwordHash }]);
    if (url.pathname.endsWith("/admin_sessions") && options.method === "DELETE") return jsonResponse(null);
    if (url.pathname.endsWith("/admin_sessions") && options.method === "POST") return jsonResponse(null, 201);
    throw new Error(`Unexpected database request: ${url.pathname}`);
  };

  const result = await handler({
    httpMethod: "POST",
    rawUrl: "https://store.example/api.php?action=login",
    headers: { origin: "https://store.example", host: "store.example", "x-forwarded-proto": "https" },
    body: JSON.stringify({ username: "AizaStore", password }),
  });

  assert.equal(result.statusCode, 200);
  assert.match(result.headers["Set-Cookie"], /HttpOnly/);
  assert.match(result.headers["Set-Cookie"], /Secure/);
  const payload = JSON.parse(result.body);
  assert.match(payload.csrf_token, /^[a-f0-9]{64}$/);
  const sessionWrite = calls.find(({ url, options }) => url.pathname.endsWith("/admin_sessions") && options.method === "POST");
  assert.ok(sessionWrite);
  assert.equal(sessionWrite.body.username, "AizaStore");
  assert.equal(sessionWrite.body.csrf_hash, createHash("sha256").update(payload.csrf_token).digest("hex"));
  assert.notEqual(sessionWrite.body.token_hash, result.headers["Set-Cookie"].match(/aiza_store_session=([^;]+)/)[1]);
});

test("admin setup upserts a scrypt password hash without changing other store data", async () => {
  let request;
  globalThis.fetch = async (input, options) => {
    request = { url: String(input), options, body: JSON.parse(options.body) };
    return jsonResponse(null, 201);
  };

  await upsertAdminAccount({
    supabaseUrl: "https://test-project.supabase.co/",
    serviceKey: "server-only-test-key",
    username: "AizaStore",
    password: "a-private-test-password",
  });

  assert.equal(request.url, "https://test-project.supabase.co/rest/v1/admin_users?on_conflict=username");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Prefer, "resolution=merge-duplicates,return=minimal");
  assert.equal(request.body.length, 1);
  assert.equal(request.body[0].username, "AizaStore");
  assert.match(request.body[0].password_hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
});
