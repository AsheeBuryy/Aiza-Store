import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const storageDirectory = resolve(root, "storage");
const storeFile = resolve(storageDirectory, "store.json");
const seedFile = resolve(root, "backend/seed.json");

function readEnvironment() {
  const values = { ...process.env };
  const envFile = resolve(root, ".env");
  if (!existsSync(envFile)) return values;

  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in values) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

const env = readEnvironment();
const sessions = new Map();
const loginAttempts = new Map();
const maxBodyBytes = 65536;

function ensureStore() {
  if (!existsSync(storeFile)) {
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, readFileSync(seedFile));
  }
}

function withStore(callback) {
  ensureStore();
  const state = JSON.parse(readFileSync(storeFile, "utf8"));
  const result = callback(state);
  mkdirSync(storageDirectory, { recursive: true });
  const temporaryFile = `${storeFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, storeFile);
  return result;
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("The request is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (body === "") {
        resolveBody({});
        return;
      }
      try {
        const result = JSON.parse(body);
        resolveBody(result && typeof result === "object" && !Array.isArray(result) ? result : {});
      } catch {
        reject(new Error("Please send a valid JSON request."));
      }
    });
    request.on("error", reject);
  });
}

function equalSecret(expected, actual) {
  const expectedHash = createHmac("sha256", "aiza-store-local-development").update(expected).digest();
  const actualHash = createHmac("sha256", "aiza-store-local-development").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash) && expected === actual;
}

function getSession(request, response) {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)aiza_store_dev=([a-f0-9]{64})(?:;|$)/);
  let id = cookie?.[1];
  let session = id ? sessions.get(id) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    id = randomBytes(32).toString("hex");
    session = { expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
    sessions.set(id, session);
    response.setHeader("Set-Cookie", `aiza_store_dev=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
  }
  return { id, session };
}

function verifySameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

function transactionId(prefix) {
  return `${prefix}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function findProduct(state, id) {
  const index = state.products.findIndex((product) => product.id === id);
  return index === -1 ? null : { index, product: state.products[index] };
}

function dashboard(state) {
  const today = new Date().toISOString().slice(0, 10);
  const todayTransactions = state.transactions.filter((transaction) => transaction.created_at.slice(0, 10) === today);
  const isSale = (transaction) =>
    ["sale", "payment", "cash_order"].includes(transaction.type) &&
    ["paid", "paid_stock_issue"].includes(transaction.status);
  const sum = (transactions, predicate) =>
    Number(transactions.reduce((total, transaction) => total + (predicate(transaction) ? transaction.amount : 0), 0).toFixed(2));

  return {
    products: state.products,
    transactions: [...state.transactions].reverse(),
    stats: {
      today_sales: sum(todayTransactions, isSale),
      total_sales: sum(state.transactions, isSale),
      cash_in_today: sum(todayTransactions, (transaction) => transaction.type === "cash_in"),
      cash_out_today: sum(todayTransactions, (transaction) => transaction.type === "cash_out"),
      low_stock_count: state.products.filter((product) => product.stock <= 5).length,
      pending_payments: state.transactions.filter((transaction) => transaction.type === "payment" && transaction.status === "pending").length,
      pending_cash_orders: state.transactions.filter((transaction) => transaction.type === "cash_order" && transaction.status === "pending").length,
    },
  };
}

async function createPaymongoCheckout(items, amount, reference, appUrl) {
  const secret = env.PAYMONGO_SECRET_KEY;
  if (!secret) throw Object.assign(new Error("GCash checkout is not configured yet. Add the PayMongo secret key to the server environment and try again."), { status: 503 });
  const response = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            amount: Math.round(item.unit_price * 100),
            currency: "PHP",
          })),
          payment_method_types: ["gcash"],
          description: `Aiza Gabutan Chang Store order ${reference}`,
          success_url: `${appUrl}/?payment=success&ref=${encodeURIComponent(reference)}`,
          cancel_url: `${appUrl}/?payment=cancelled&ref=${encodeURIComponent(reference)}`,
          metadata: { order_reference: reference },
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("PayMongo checkout request failed with status", response.status);
    throw Object.assign(new Error("PayMongo could not start checkout. Check the merchant setup and try again."), { status: 502 });
  }
  const session = result?.data;
  const checkoutUrl = session?.attributes?.checkout_url;
  if (typeof session?.id !== "string" || typeof checkoutUrl !== "string" || new URL(checkoutUrl).protocol !== "https:") {
    throw Object.assign(new Error("PayMongo returned an incomplete checkout response. Please try again."), { status: 502 });
  }
  return { checkoutId: session.id, checkoutUrl };
}

async function handleApi(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const action = url.searchParams.get("action") ?? "";
  const method = request.method ?? "GET";
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");

  if (action === "products" && method === "GET") {
    return withStore((state) => json(response, 200, { products: state.products }));
  }

  if (!verifySameOrigin(request)) return json(response, 403, { error: "This request did not come from the store website." });
  const { session } = getSession(request, response);

  if (action === "login" && method === "POST") {
    const ip = request.socket.remoteAddress ?? "unknown";
    const recent = (loginAttempts.get(ip) ?? []).filter((time) => time > Date.now() - 15 * 60 * 1000);
    if (recent.length >= 8) return json(response, 429, { error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
    loginAttempts.set(ip, [...recent, Date.now()]);
    const body = await readBody(request);
    const username = env.ADMIN_USERNAME ?? "";
    const password = env.ADMIN_PASSWORD ?? "";
    if (!username || !password) return json(response, 503, { error: "Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env." });
    if (typeof body.username !== "string" || typeof body.password !== "string" ||
        !equalSecret(username, body.username) || !equalSecret(password, body.password)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      return json(response, 401, { error: "That username and password do not match." });
    }
    loginAttempts.delete(ip);
    for (const [id, current] of sessions) if (current === session) sessions.delete(id);
    const id = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    const authenticatedSession = { admin: true, csrfToken, expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
    sessions.set(id, authenticatedSession);
    response.setHeader("Set-Cookie", `aiza_store_dev=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
    return json(response, 200, { csrf_token: csrfToken });
  }

  if (action === "webhook" && method === "POST") {
    const rawBody = await new Promise((resolveBody, reject) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > maxBodyBytes) reject(new Error("The webhook body is too large."));
      });
      request.on("end", () => resolveBody(body));
      request.on("error", reject);
    });
    const secret = env.PAYMONGO_WEBHOOK_SECRET ?? "";
    const header = request.headers["paymongo-signature"];
    if (!secret || typeof header !== "string") return json(response, 503, { error: "The PayMongo webhook is not configured." });
    const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2)));
    const timestamp = parts.t ?? "";
    const mode = env.PAYMONGO_MODE === "live" ? "li" : "te";
    const signature = parts[mode] ?? "";
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signature) {
      return json(response, 400, { error: "The webhook signature is invalid or expired." });
    }
    const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    if (!equalSecret(digest, signature)) return json(response, 400, { error: "The webhook signature is invalid." });
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return json(response, 400, { error: "Webhook body is invalid JSON." });
    }
    const eventType = event?.data?.attributes?.type;
    const checkout = event?.data?.attributes?.data;
    const checkoutId = checkout?.id;
    if (typeof checkoutId !== "string" || !checkoutId) return json(response, 400, { error: "Webhook does not contain a checkout session." });
    const paid = ["checkout_session.payment.paid", "checkout_session.payment.paid.v2"].includes(eventType) ||
      (eventType === "payment.paid" && checkout?.attributes?.status === "paid");
    const failed = ["checkout_session.payment.failed", "checkout_session.expired"].includes(eventType);
    if (!paid && !failed) return json(response, 200, { received: true });
    const updated = withStore((state) => {
      const transaction = state.transactions.find((entry) => entry.checkout_id === checkoutId);
      if (!transaction) return false;
      if (transaction.status !== "pending") return true;
      if (!paid) {
        transaction.status = "failed";
        return true;
      }
      const products = transaction.items.map((item) => findProduct(state, item.id));
      const canFulfill = products.every((product, index) => product && product.product.stock >= transaction.items[index].quantity);
      transaction.status = canFulfill ? "paid" : "paid_stock_issue";
      transaction.confirmed_at = new Date().toISOString();
      if (canFulfill) transaction.items.forEach((item, index) => { products[index].product.stock -= item.quantity; });
      return true;
    });
    if (!updated) return json(response, 404, { error: "Checkout session is not in the store record yet." });
    return json(response, 200, { received: true });
  }

  if (method === "GET" && action === "admin") {
    if (!session.admin) return json(response, 401, { error: "Please sign in to manage the store." });
    return withStore((state) => json(response, 200, dashboard(state)));
  }

  if (method === "POST" && action === "logout") {
    if (!session.admin) return json(response, 401, { error: "Please sign in to manage the store." });
    if (request.headers["x-csrf-token"] !== session.csrfToken) return json(response, 403, { error: "Your session has expired. Please sign in again." });
    for (const [id, current] of sessions) if (current === session) sessions.delete(id);
    response.setHeader("Set-Cookie", "aiza_store_dev=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return json(response, 200, { success: true });
  }

  const adminActions = new Set(["cash_in", "cash_out", "restock", "add_product", "update_product", "record_sale", "confirm_cash_order", "cancel_cash_order"]);
  if (method === "POST" && adminActions.has(action)) {
    if (!session.admin) return json(response, 401, { error: "Please sign in to manage the store." });
    if (request.headers["x-csrf-token"] !== session.csrfToken) return json(response, 403, { error: "Your session has expired. Please sign in again." });
    const body = await readBody(request);

    if (action === "confirm_cash_order" || action === "cancel_cash_order") {
      const result = withStore((state) => {
        const transaction = state.transactions.find((entry) => entry.id === body.transaction_id && entry.type === "cash_order");
        if (!transaction) return { error: "That cash order could not be found.", status: 404 };
        if (transaction.status !== "pending") return { error: "That cash order has already been updated.", status: 409 };
        if (action === "cancel_cash_order") {
          transaction.status = "cancelled";
          transaction.cancelled_at = new Date().toISOString();
          return { success: true };
        }
        const products = transaction.items.map((item) => findProduct(state, item.id));
        if (products.some((product, index) => !product || product.product.stock < transaction.items[index].quantity)) {
          return { error: "There is not enough stock to confirm this order. Restock the items or cancel the order.", status: 409 };
        }
        transaction.items.forEach((item, index) => { products[index].product.stock -= item.quantity; });
        transaction.status = "paid";
        transaction.confirmed_at = new Date().toISOString();
        return { success: true };
      });
      return result.error ? json(response, result.status, { error: result.error }) : json(response, 200, result);
    }

    if (action === "restock") {
      const quantity = Number(body.quantity);
      if (typeof body.product_id !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
        return json(response, 422, { error: "Enter a restock quantity between 1 and 10,000." });
      }
      const found = withStore((state) => {
        const product = findProduct(state, body.product_id);
        if (product) product.product.stock += quantity;
        return Boolean(product);
      });
      return found ? json(response, 200, { success: true }) : json(response, 404, { error: "That product is no longer in the inventory." });
    }

    if (action === "add_product") {
      const price = Number(body.price);
      const stock = body.stock === "" || body.stock === undefined ? 0 : Number(body.stock);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const category = typeof body.category === "string" ? body.category.trim() : "";
      const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim() : "🛒";
      if (!name || name.length > 80 ||
          category.length > 50 ||
          !Number.isFinite(price) || price <= 0 || price > 100000 ||
          !Number.isInteger(stock) || stock < 0 || stock > 100000 ||
          emoji.length > 8) {
        return json(response, 422, { error: "Please enter a product name and a price. Category and starting stock are optional." });
      }
      withStore((state) => state.products.push({
        id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${randomBytes(3).toString("hex")}`,
        name,
        category: category || "Uncategorized",
        price: Number(price.toFixed(2)),
        stock,
        emoji,
        description: "An everyday store favorite.",
      }));
      return json(response, 201, { success: true });
    }

    if (action === "update_product") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const category = typeof body.category === "string" ? body.category.trim() : "";
      const price = Number(body.price);
      const stock = Number(body.stock);
      const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim() : "🛒";
      if (typeof body.product_id !== "string" || !name || name.length > 80 ||
          category.length > 50 || !Number.isFinite(price) || price <= 0 || price > 100000 ||
          !Number.isInteger(stock) || stock < 0 || stock > 100000 || emoji.length > 8) {
        return json(response, 422, { error: "Please enter a product name, price, and valid stock quantity. Category is optional." });
      }
      const updated = withStore((state) => {
        const found = findProduct(state, body.product_id);
        if (!found) return false;
        Object.assign(found.product, {
          name,
          category: category || "Uncategorized",
          price: Number(price.toFixed(2)),
          stock,
          emoji,
        });
        return true;
      });
      return updated ? json(response, 200, { success: true }) : json(response, 404, { error: "That product is no longer in the inventory." });
    }

    if (action === "cash_in" || action === "cash_out") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 ||
          typeof body.description !== "string" || body.description.trim().length < 2 || body.description.length > 120) {
        return json(response, 422, { error: "Enter a valid amount (up to ₱100,000) and a short transaction note." });
      }
      withStore((state) => state.transactions.push({
        id: transactionId("LEDGER"),
        type: action,
        status: "recorded",
        amount: Number(amount.toFixed(2)),
        description: body.description.trim(),
        payment_method: "Manual store record",
        created_at: new Date().toISOString(),
      }));
      return json(response, 201, { success: true });
    }

    if (action === "record_sale") {
      const quantity = Number(body.quantity);
      if (typeof body.product_id !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return json(response, 422, { error: "Choose an item and a valid sale quantity." });
      }
      const result = withStore((state) => {
        const found = findProduct(state, body.product_id);
        if (!found) return { error: "That product is no longer in the inventory.", status: 404 };
        if (found.product.stock < quantity) return { error: "There is not enough stock to record this sale.", status: 422 };
        found.product.stock -= quantity;
        state.transactions.push({
          id: transactionId("SALE"),
          type: "sale",
          status: "paid",
          amount: Number((found.product.price * quantity).toFixed(2)),
          description: `${found.product.name} × ${quantity}`,
          payment_method: "Cash",
          created_at: new Date().toISOString(),
        });
        return { success: true };
      });
      return result.error ? json(response, result.status, { error: result.error }) : json(response, 201, result);
    }
  }

  if (method === "POST" && action === "checkout") {
    const body = await readBody(request);
    if (!["cash", "gcash"].includes(body.payment_method) || !Array.isArray(body.items) || !body.items.length || body.items.length > 30) {
      return json(response, 422, { error: "Choose cash at the store or GCash and add at least one item to your basket." });
    }
    const items = withStore((state) => body.items.map((requested) => {
      if (!requested || typeof requested.id !== "string" || !Number.isInteger(requested.quantity) || requested.quantity < 1 || requested.quantity > 100) {
        throw Object.assign(new Error("One of the basket items is invalid."), { status: 422 });
      }
      const found = findProduct(state, requested.id);
      if (!found) throw Object.assign(new Error("An item in your basket is no longer available. Please refresh the page."), { status: 422 });
      if (requested.quantity > found.product.stock) throw Object.assign(new Error(`${found.product.name} does not have enough stock for this basket.`), { status: 422 });
      return { id: found.product.id, name: found.product.name, quantity: requested.quantity, unit_price: found.product.price };
    }));
    if (new Set(items.map((item) => item.id)).size !== items.length) return json(response, 422, { error: "Please remove duplicate items from your basket and try again." });
    const amount = Number(items.reduce((total, item) => total + item.unit_price * item.quantity, 0).toFixed(2));
    const reference = transactionId("AIZA");
    if (body.payment_method === "cash") {
      withStore((state) => state.transactions.push({
        id: reference,
        type: "cash_order",
        status: "pending",
        amount,
        description: `Cash order (${items.length} items)`,
        payment_method: "Cash at store",
        items,
        created_at: new Date().toISOString(),
      }));
      return json(response, 201, { cash_order: true, reference });
    }
    let checkout;
    try {
      checkout = await createPaymongoCheckout(items, amount, reference, (env.APP_URL ?? "http://localhost:5173").replace(/\/+$/, ""));
    } catch (error) {
      return json(response, error.status ?? 502, { error: error.message ?? "PayMongo could not be reached." });
    }
    withStore((state) => state.transactions.push({
      id: reference,
      checkout_id: checkout.checkoutId,
      type: "payment",
      status: "pending",
      amount,
      description: `GCash checkout (${items.length} items)`,
      payment_method: "PayMongo GCash",
      items,
      created_at: new Date().toISOString(),
    }));
    return json(response, 200, { checkout_url: checkout.checkoutUrl, reference });
  }

  if (method !== "GET" && method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return json(response, 405, { error: "This store action uses a different HTTP method." });
  }
  return json(response, 404, { error: "That store action was not found." });
}

export function devApiPlugin() {
  return {
    name: "aiza-store-local-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api.php")) return next();
        handleApi(request, response).catch((error) => {
          if (response.headersSent) return response.end();
          const status = Number.isInteger(error.status) ? error.status : 500;
          if (status === 500) console.error("Local store API error:", error);
          json(response, status, { error: status === 500 ? "The store could not complete that request. Please try again." : error.message });
        });
      });
    },
  };
}
