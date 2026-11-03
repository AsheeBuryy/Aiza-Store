import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const sessionCookie = "aiza_store_session";
const sessionLifetimeSeconds = 8 * 60 * 60;
const maxBodyBytes = 65536;
const maxReceiptBytes = 2 * 1024 * 1024;
const maxReceiptRequestBytes = 3 * 1024 * 1024;
const receiptBucket = "gcash-payment-receipts";

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requiredEnvironment() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    fail(503, "The store database is not configured. Set its server environment variables in Netlify.");
  }
  return { supabaseUrl, serviceKey };
}

async function databaseRequest(path, { method = "GET", body, prefer } = {}) {
  const { supabaseUrl, serviceKey } = requiredEnvironment();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  let result;
  try {
    result = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("Supabase request could not be completed.", error instanceof Error ? error.message : "Unknown network error.");
    fail(503, "The store database could not be reached. Please try again.");
  }

  const text = await result.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      console.error("Supabase returned a non-JSON response.", result.status);
      fail(503, "The store database returned an unexpected response.");
    }
  }
  if (!result.ok) {
    console.error("Supabase request failed.", { status: result.status, path: path.split("?")[0] });
    fail(503, "The store database could not complete that request.");
  }
  return payload;
}

async function storageRequest(path, { method = "POST", body, contentType } = {}) {
  const { supabaseUrl, serviceKey } = requiredEnvironment();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = contentType ?? "application/json";
  if (method === "POST" && path.startsWith("object/") && !path.startsWith("object/sign/")) {
    headers["x-upsert"] = "true";
  }

  let result;
  try {
    result = await fetch(`${supabaseUrl}/storage/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error("Supabase Storage request could not be completed.", error instanceof Error ? error.message : "Unknown network error.");
    fail(503, "The GCash receipt could not be stored. Please try again.");
  }
  const text = await result.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      console.error("Supabase Storage returned a non-JSON response.", result.status);
      fail(503, "The GCash receipt service returned an unexpected response.");
    }
  }
  if (!result.ok) {
    console.error("Supabase Storage request failed.", { status: result.status, path: path.split("?")[0] });
    fail(503, "The GCash receipt could not be stored. Please try again.");
  }
  return payload;
}

function tablePath(table, query = {}) {
  const params = new URLSearchParams(query);
  return `${table}?${params.toString()}`;
}

async function getGcashNumber() {
  const rows = await databaseRequest(tablePath("store_settings", {
    select: "value",
    key: "eq.gcash_number",
    limit: "1",
  }));
  const number = rows?.[0]?.value;
  if (typeof number !== "string" || !/^09\d{9}$/.test(number)) {
    fail(503, "The store GCash contact number is not configured. Run the latest Supabase migration.");
  }
  return number;
}

async function rpc(name, args) {
  return databaseRequest(`rpc/${name}`, { method: "POST", body: args });
}

function normalizeProduct(product) {
  return { ...product, price: Number(product.price), stock: Number(product.stock) };
}

function normalizeTransaction(transaction) {
  return { ...transaction, amount: Number(transaction.amount) };
}

function randomId(prefix) {
  return `${prefix}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function jsonResponseError(result, fallbackStatus = 500) {
  if (result?.error) fail(Number(result.status) || fallbackStatus, result.error);
}

async function readBody(event, limit = maxBodyBytes) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (Buffer.byteLength(raw, "utf8") > limit) fail(413, "The request is too large.");
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Please send a valid JSON request.");
    return body;
  } catch (error) {
    if (error?.status) throw error;
    fail(400, "Please send a valid JSON request.");
  }
}

function getHeader(headers, name) {
  const key = Object.keys(headers ?? {}).find((header) => header.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function verifySameOrigin(event) {
  const origin = getHeader(event.headers, "origin");
  if (!origin) return true;
  const host = getHeader(event.headers, "x-forwarded-host") ?? getHeader(event.headers, "host");
  try {
    return Boolean(host) && new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function cookieValue(headers, name) {
  const cookie = getHeader(headers, "cookie") ?? "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : "";
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function setSessionCookie(token, secure = true) {
  return `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure = true) {
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function secureRequest(event) {
  return getHeader(event.headers, "x-forwarded-proto") !== "http";
}

async function requireAdmin(event) {
  const token = cookieValue(event.headers, sessionCookie);
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, "Please sign in to manage the store.");
  const rows = await databaseRequest(tablePath("admin_sessions", {
    select: "token_hash,csrf_hash,username,expires_at",
    token_hash: `eq.${hash(token)}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  }));
  const session = rows?.[0];
  if (!session) fail(401, "Please sign in to manage the store.");
  return session;
}

async function requireCsrf(event, session) {
  const supplied = getHeader(event.headers, "x-csrf-token");
  if (!hashesEqual(session.csrf_hash, hash(supplied ?? ""))) {
    fail(403, "Your session has expired. Please sign in again.");
  }
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash).split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(expectedHex ?? "")) {
    return false;
  }
  const actual = await scryptAsync(password, salt, 64);
  return hashesEqual(expectedHex, actual.toString("hex"));
}

function getClientIpHash(event) {
  const ip = getHeader(event.headers, "x-nf-client-connection-ip")
    ?? getHeader(event.headers, "x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const { serviceKey } = requiredEnvironment();
  return createHmac("sha256", serviceKey).update(ip).digest("hex");
}

async function login(event, body) {
  if (typeof body.username !== "string" || body.username.trim().length > 80
      || typeof body.password !== "string" || body.password.length > 1024) {
    fail(422, "Enter your administrator username and password.");
  }
  const allowed = await rpc("store_record_login_attempt", {
    p_ip_hash: getClientIpHash(event),
    p_success: false,
  });
  if (!allowed) fail(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");

  const rows = await databaseRequest(tablePath("admin_users", {
    select: "username,password_hash",
    username: `eq.${body.username.trim()}`,
    limit: "1",
  }));
  const admin = rows?.[0];
  if (!admin || !(await verifyPassword(body.password, admin.password_hash))) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    fail(401, "That username and password do not match.");
  }

  await rpc("store_record_login_attempt", { p_ip_hash: getClientIpHash(event), p_success: true });
  await databaseRequest(tablePath("admin_sessions", {
    expires_at: `lt.${new Date().toISOString()}`,
  }), { method: "DELETE" });
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000).toISOString();
  await databaseRequest("admin_sessions", {
    method: "POST",
    body: {
      token_hash: hash(token),
      csrf_hash: hash(csrfToken),
      username: admin.username,
      expires_at: expiresAt,
    },
    prefer: "return=minimal",
  });
  return response(200, { csrf_token: csrfToken }, {
    "Set-Cookie": setSessionCookie(token, secureRequest(event)),
  });
}

async function checkout(body) {
  if (!["cash", "gcash"].includes(body.payment_method) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    fail(422, "Choose cash at the store or GCash and add at least one item to your basket.");
  }
  const requested = body.items;
  if (requested.some((item) => !item || typeof item.id !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)
      || new Set(requested.map((item) => item.id)).size !== requested.length) {
    fail(422, "One or more basket items are invalid. Remove duplicate items and try again.");
  }

  const products = await databaseRequest(tablePath("store_products", { select: "*", order: "name.asc" }));
  const byId = new Map(products.map((product) => [product.id, normalizeProduct(product)]));
  const items = requested.map((requestedItem) => {
    const product = byId.get(requestedItem.id);
    if (!product) fail(422, "An item in your basket is no longer available. Please refresh the page.");
    if (requestedItem.quantity > product.stock) fail(422, `${product.name} does not have enough stock for this basket.`);
    return {
      id: product.id,
      name: product.name,
      quantity: requestedItem.quantity,
      unit_price: product.price,
    };
  });
  const total = Number(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0).toFixed(2));
  const reference = randomId("AIZA");
  const row = {
    id: reference,
    type: body.payment_method === "cash" ? "cash_order" : "payment",
    status: "pending",
    amount: total,
    description: `${body.payment_method === "cash" ? "Cash order" : "GCash transfer"} (${items.length} items)`,
    payment_method: body.payment_method === "cash" ? "Cash at store" : "Manual GCash",
    items,
  };

  if (body.payment_method === "cash") {
    await databaseRequest("store_transactions", { method: "POST", body: row, prefer: "return=minimal" });
    return response(201, { cash_order: true, reference });
  }

  const gcashNumber = await getGcashNumber();
  const submissionToken = randomBytes(32).toString("hex");
  row.gcash_reference = null;
  row.receipt_path = null;
  row.submission_token_hash = hash(submissionToken);
  await databaseRequest("store_transactions", {
    method: "POST",
    body: row,
    prefer: "return=minimal",
  });
  return response(201, {
    manual_gcash_order: true,
    reference,
    amount: total,
    gcash_number: gcashNumber,
    submission_token: submissionToken,
  });
}

function parseReceiptDataUrl(value) {
  if (typeof value !== "string") fail(422, "Choose a JPG, PNG, or WebP receipt image.");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) fail(422, "Choose a JPG, PNG, or WebP receipt image.");
  const [, contentType, encoded] = match;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maxReceiptBytes) {
    fail(413, "Receipt images must be no larger than 2 MB.");
  }
  const isJpeg = contentType === "image/jpeg" && bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = contentType === "image/png" && bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = contentType === "image/webp" && bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) fail(422, "The selected file is not a valid JPG, PNG, or WebP image.");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  return { bytes, contentType, extension };
}

async function submitGcashPayment(body) {
  if (typeof body.transaction_id !== "string" || !/^AIZA-[A-F0-9]{10}$/.test(body.transaction_id)
      || typeof body.submission_token !== "string" || !/^[a-f0-9]{64}$/.test(body.submission_token)) {
    fail(422, "The GCash order details are invalid. Please start checkout again.");
  }
  const gcashReference = typeof body.gcash_reference === "string" ? body.gcash_reference.trim() : "";
  if (!/^[A-Za-z0-9-]{4,40}$/.test(gcashReference)) {
    fail(422, "Enter the 4–40 character GCash transfer reference number.");
  }
  const tokenHash = hash(body.submission_token);
  const matchingOrder = await databaseRequest(tablePath("store_transactions", {
    select: "id",
    id: `eq.${body.transaction_id}`,
    type: "eq.payment",
    payment_method: "eq.Manual GCash",
    status: "eq.pending",
    submission_token_hash: `eq.${tokenHash}`,
    receipt_path: "is.null",
    limit: "1",
  }));
  if (!matchingOrder?.length) {
    fail(409, "This GCash order is no longer available for receipt submission. Please contact the store.");
  }
  const { bytes, contentType, extension } = parseReceiptDataUrl(body.receipt_data_url);
  const receiptPath = `${body.transaction_id}.${extension}`;
  await storageRequest(`object/${receiptBucket}/${receiptPath}`, {
    body: bytes,
    contentType,
  });
  const updated = await databaseRequest(tablePath("store_transactions", {
    id: `eq.${body.transaction_id}`,
    type: "eq.payment",
    payment_method: "eq.Manual GCash",
    status: "eq.pending",
    submission_token_hash: `eq.${tokenHash}`,
    receipt_path: "is.null",
  }), {
    method: "PATCH",
    body: { gcash_reference: gcashReference, receipt_path: receiptPath },
    prefer: "return=representation",
  });
  if (!updated?.length) fail(409, "This GCash order is no longer available for receipt submission. Please contact the store.");
  return response(200, { success: true });
}

async function signedReceiptUrl(receiptPath) {
  if (typeof receiptPath !== "string" || !/^AIZA-[A-F0-9]{10}\.(?:jpg|png|webp)$/.test(receiptPath)) {
    fail(503, "A GCash receipt record is invalid. Please contact support.");
  }
  const result = await storageRequest(`object/sign/${receiptBucket}/${receiptPath}`, {
    body: { expiresIn: 3600 },
  });
  if (typeof result?.signedURL !== "string") {
    fail(503, "The GCash receipt could not be opened. Please try again.");
  }
  const { supabaseUrl } = requiredEnvironment();
  if (/^https?:\/\//i.test(result.signedURL)) return result.signedURL;
  return `${supabaseUrl}/storage/v1/${result.signedURL.replace(/^\/+/, "")}`;
}

async function verifyWebhook(event) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  const signatureHeader = getHeader(event.headers, "paymongo-signature");
  if (!secret || typeof signatureHeader !== "string") {
    fail(503, "The PayMongo webhook is not configured.");
  }
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) fail(413, "The webhook body is too large.");
  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => {
    const [key, value] = part.trim().split("=", 2);
    return [key, value ?? ""];
  }));
  const timestamp = parts.t ?? "";
  const mode = process.env.PAYMONGO_MODE?.toLowerCase() === "live" ? "li" : "te";
  const signature = parts[mode] ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signature) {
    fail(400, "The webhook signature is invalid or expired.");
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (!hashesEqual(expected, signature)) fail(400, "The webhook signature is invalid or expired.");
  let eventBody;
  try {
    eventBody = JSON.parse(rawBody);
  } catch {
    fail(400, "Webhook body is invalid JSON.");
  }
  return eventBody;
}

async function handleWebhook(event) {
  const body = await verifyWebhook(event);
  const attributes = body?.data?.attributes;
  const type = attributes?.type;
  const checkout = attributes?.data;
  const checkoutId = checkout?.id;
  if (typeof checkoutId !== "string" || !checkoutId) fail(400, "Webhook does not contain a checkout session.");
  const paid = ["checkout_session.payment.paid", "checkout_session.payment.paid.v2"].includes(type)
    || (type === "payment.paid" && checkout?.attributes?.status === "paid");
  const failed = ["checkout_session.payment.failed", "checkout_session.expired"].includes(type);
  if (!paid && !failed) return response(200, { received: true });
  const result = await rpc("store_resolve_payment", { p_checkout_id: checkoutId, p_paid: paid });
  if (!result?.found) fail(404, "Checkout session is not in the store record yet.");
  return response(200, { received: true });
}

async function dashboard() {
  const [productRows, transactionRows, gcashNumber] = await Promise.all([
    databaseRequest(tablePath("store_products", { select: "*", order: "name.asc" })),
    databaseRequest(tablePath("store_transactions", { select: "*", order: "created_at.desc" })),
    getGcashNumber(),
  ]);
  const products = productRows.map(normalizeProduct);
  const transactions = await Promise.all(transactionRows.map(async (transaction) => {
    const { submission_token_hash: submissionTokenHash, ...safeTransaction } = transaction;
    return {
      ...normalizeTransaction(safeTransaction),
      receipt_required: Boolean(submissionTokenHash),
      receipt_url: transaction.receipt_path ? await signedReceiptUrl(transaction.receipt_path) : null,
    };
  }));
  const today = new Date().toISOString().slice(0, 10);
  const todayTransactions = transactions.filter((transaction) => transaction.created_at.slice(0, 10) === today);
  const isSale = (transaction) => ["sale", "payment", "cash_order"].includes(transaction.type)
    && ["paid", "paid_stock_issue"].includes(transaction.status);
  const sum = (rows, predicate) => Number(rows.reduce(
    (total, transaction) => total + (predicate(transaction) ? transaction.amount : 0),
    0,
  ).toFixed(2));
  return {
    products,
    transactions,
    gcash_number: gcashNumber,
    stats: {
      today_sales: sum(todayTransactions, isSale),
      total_sales: sum(transactions, isSale),
      cash_in_today: sum(todayTransactions, (transaction) => transaction.type === "cash_in"),
      cash_out_today: sum(todayTransactions, (transaction) => transaction.type === "cash_out"),
      low_stock_count: products.filter((product) => product.stock <= 5).length,
      pending_payments: transactions.filter((transaction) =>
        transaction.type === "payment" && transaction.payment_method === "Manual GCash" && transaction.status === "pending",
      ).length,
      pending_cash_orders: transactions.filter((transaction) => transaction.type === "cash_order" && transaction.status === "pending").length,
    },
  };
}

async function handleAdminAction(action, body) {
  if (action === "confirm_gcash_payment" || action === "cancel_gcash_payment") {
    if (typeof body.transaction_id !== "string" || !body.transaction_id) fail(422, "Choose a GCash payment to update.");
    const result = await rpc("store_resolve_gcash_payment", {
      p_transaction_id: body.transaction_id,
      p_paid: action === "confirm_gcash_payment",
    });
    jsonResponseError(result, 409);
    return response(200, { success: true });
  }

  if (action === "update_gcash_number") {
    if (typeof body.gcash_number !== "string") fail(422, "Enter a valid Philippine mobile number.");
    const submitted = body.gcash_number.trim().replace(/[\s-]/g, "");
    const gcashNumber = /^\+639\d{9}$/.test(submitted) ? `0${submitted.slice(3)}` : submitted;
    if (!/^09\d{9}$/.test(gcashNumber)) fail(422, "Enter an 11-digit number starting with 09 or a +63 number.");
    await databaseRequest(tablePath("store_settings", { on_conflict: "key" }), {
      method: "POST",
      body: { key: "gcash_number", value: gcashNumber },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    return response(200, { success: true });
  }

  if (action === "confirm_cash_order" || action === "cancel_cash_order") {
    if (typeof body.transaction_id !== "string" || !body.transaction_id) fail(422, "Choose a cash order to update.");
    const result = await rpc("store_resolve_cash_order", {
      p_transaction_id: body.transaction_id,
      p_cancel: action === "cancel_cash_order",
    });
    jsonResponseError(result, 409);
    return response(200, { success: true });
  }

  if (action === "cash_in" || action === "cash_out") {
    const amount = Number(body.amount);
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 || description.length < 2 || description.length > 120) {
      fail(422, "Enter a valid amount (up to ₱100,000) and a short transaction note.");
    }
    await databaseRequest("store_transactions", {
      method: "POST",
      body: {
        id: randomId("LEDGER"),
        type: action,
        status: "recorded",
        amount: Number(amount.toFixed(2)),
        description,
        payment_method: "Manual store record",
      },
      prefer: "return=minimal",
    });
    return response(201, { success: true });
  }

  if (action === "restock") {
    const quantity = Number(body.quantity);
    if (typeof body.product_id !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      fail(422, "Enter a restock quantity between 1 and 10,000.");
    }
    const found = await rpc("store_restock", { p_product_id: body.product_id, p_quantity: quantity });
    jsonResponseError(found, 422);
    return response(200, { success: true });
  }

  if (action === "add_product") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const price = Number(body.price);
    const stock = body.stock === "" || body.stock === undefined ? 0 : Number(body.stock);
    const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim() : "🛒";
    if (!name || name.length > 80 || category.length > 50 || !Number.isFinite(price) || price <= 0 || price > 100000
      || !Number.isInteger(stock) || stock < 0 || stock > 100000 || emoji.length > 8) {
      fail(422, "Please enter a product name and a price. Category and starting stock are optional.");
    }
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${randomBytes(3).toString("hex")}`;
    await databaseRequest("store_products", {
      method: "POST",
      body: {
        id,
        name,
        category: category || "Uncategorized",
        price: Number(price.toFixed(2)),
        stock,
        emoji,
        description: "An everyday store favorite.",
      },
      prefer: "return=minimal",
    });
    return response(201, { success: true });
  }

  if (action === "update_product") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const price = Number(body.price);
    const stock = Number(body.stock);
    const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim() : "🛒";
    if (typeof body.product_id !== "string" || !body.product_id || !name || name.length > 80
      || category.length > 50 || !Number.isFinite(price) || price <= 0 || price > 100000
      || !Number.isInteger(stock) || stock < 0 || stock > 100000 || emoji.length > 8) {
      fail(422, "Please enter a product name, price, and valid stock quantity. Category is optional.");
    }
    const updated = await databaseRequest(tablePath("store_products", { id: `eq.${body.product_id}` }), {
      method: "PATCH",
      body: {
        name,
        category: category || "Uncategorized",
        price: Number(price.toFixed(2)),
        stock,
        emoji,
      },
      prefer: "return=representation",
    });
    if (!updated?.length) fail(404, "That product is no longer in the inventory.");
    return response(200, { success: true });
  }

  if (action === "record_sale") {
    const quantity = Number(body.quantity);
    if (typeof body.product_id !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      fail(422, "Choose an item and a valid sale quantity.");
    }
    const result = await rpc("store_record_sale", {
      p_product_id: body.product_id,
      p_quantity: quantity,
      p_transaction_id: randomId("SALE"),
    });
    jsonResponseError(result, 422);
    return response(201, { success: true });
  }

  fail(404, "That store action was not found.");
}

export async function handler(event) {
  const method = event.httpMethod ?? "GET";
  const url = new URL(event.rawUrl ?? event.path ?? "/", "https://netlify.local");
  const action = url.searchParams.get("action") ?? event.queryStringParameters?.action ?? "";

  try {
    if (action === "products" && method === "GET") {
      const [rows, gcashNumber] = await Promise.all([
        databaseRequest(tablePath("store_products", { select: "*", order: "name.asc" })),
        getGcashNumber(),
      ]);
      return response(200, { products: rows.map(normalizeProduct), gcash_number: gcashNumber });
    }
    if (action === "webhook" && method === "POST") return await handleWebhook(event);
    if (action === "login" && method === "POST") {
      if (!verifySameOrigin(event)) fail(403, "This request did not come from the store website.");
      return await login(event, await readBody(event));
    }
    if (action === "checkout" && method === "POST") {
      if (!verifySameOrigin(event)) fail(403, "This request did not come from the store website.");
      return await checkout(await readBody(event));
    }
    if (action === "submit_gcash_payment" && method === "POST") {
      if (!verifySameOrigin(event)) fail(403, "This request did not come from the store website.");
      return await submitGcashPayment(await readBody(event, maxReceiptRequestBytes));
    }

    const adminActions = new Set([
      "cash_in",
      "cash_out",
      "restock",
      "add_product",
      "update_product",
      "record_sale",
      "confirm_cash_order",
      "cancel_cash_order",
      "confirm_gcash_payment",
      "cancel_gcash_payment",
      "update_gcash_number",
    ]);
    if (action === "admin" && method === "GET") {
      await requireAdmin(event);
      return response(200, await dashboard());
    }
    if (action === "logout" && method === "POST") {
      if (!verifySameOrigin(event)) fail(403, "This request did not come from the store website.");
      const session = await requireAdmin(event);
      await requireCsrf(event, session);
      await databaseRequest(tablePath("admin_sessions", { token_hash: `eq.${session.token_hash}` }), { method: "DELETE" });
      return response(200, { success: true }, { "Set-Cookie": clearSessionCookie(secureRequest(event)) });
    }
    if (adminActions.has(action) && method === "POST") {
      if (!verifySameOrigin(event)) fail(403, "This request did not come from the store website.");
      const session = await requireAdmin(event);
      await requireCsrf(event, session);
      return await handleAdminAction(action, await readBody(event));
    }
    return response(404, { error: "That store action was not found." });
  } catch (error) {
    if (error?.status) return response(error.status, { error: error.message });
    console.error("Store API request failed.", error instanceof Error ? error.message : "Unknown error.");
    return response(500, { error: "The store could not complete that request. Please try again." });
  }
}
