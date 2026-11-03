import { FormEvent, useEffect, useMemo, useState } from "react";
import catalog from "../backend/seed.json";

const DEMO_MODE = import.meta.env.MODE === "demo";

type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  emoji: string;
  description: string;
};

type CartLine = { product: Product; quantity: number };
type Transaction = {
  id: string;
  type: "sale" | "payment" | "cash_order" | "cash_in" | "cash_out";
  status: string;
  amount: number;
  description: string;
  created_at: string;
  payment_method: string;
  gcash_reference?: string | null;
  receipt_url?: string | null;
  receipt_required?: boolean;
};

type PendingGcashOrder = {
  reference: string;
  amount: number;
  gcash_number: string;
  submission_token: string;
};

type AdminData = {
  products: Product[];
  transactions: Transaction[];
  gcash_number: string;
  stats: {
    today_sales: number;
    total_sales: number;
    cash_in_today: number;
    cash_out_today: number;
    low_stock_count: number;
    pending_payments: number;
    pending_cash_orders: number;
  };
};

type StoreData = { products: Product[]; gcash_number: string };

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 2,
});

async function apiRequest<T>(action: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api.php?action=${encodeURIComponent(action)}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const responseBody = await response.text();
  let result: (T & { error?: string }) | null;
  try {
    result = JSON.parse(responseBody) as (T & { error?: string }) | null;
  } catch {
    throw new Error(
      `The store API returned a non-JSON response (HTTP ${response.status}${contentType ? `, ${contentType}` : ""}). Check the Netlify API deployment and function configuration.`,
    );
  }
  if (!response.ok) throw new Error(result?.error ?? "The request could not be completed.");
  if (result === null || typeof result !== "object") {
    throw new Error("The store API returned an empty response. Please check the server configuration.");
  }
  return result;
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [gcashNumber, setGcashNumber] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState("All items");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [storeError, setStoreError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "gcash">("cash");
  const [gcashOrder, setGcashOrder] = useState<PendingGcashOrder | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [adminError, setAdminError] = useState("");

  async function loadProducts() {
    setLoading(true);
    setStoreError("");
    try {
      const result = await apiRequest<StoreData>("products");
      setProducts(result.products);
      setGcashNumber(result.gcash_number);
    } catch (error) {
      setStoreError(error instanceof Error ? error.message : "Unable to load store products.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAdmin() {
    try {
      const result = await apiRequest<AdminData>("admin");
      setAdmin(result);
      setProducts(result.products);
      setGcashNumber(result.gcash_number);
      setAdminError("");
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Unable to load the admin dashboard.");
    }
  }

  useEffect(() => {
    if (DEMO_MODE) {
      setProducts(catalog.products);
      setLoading(false);
      return;
    }
    void loadProducts();
    const params = new URLSearchParams(window.location.search);
    if (params.has("payment")) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const categories = useMemo(
    () => ["All items", ...new Set(products.map((product) => product.category))],
    [products],
  );

  const visibleProducts = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return products.filter((product) => {
      const matchesCategory = category === "All items" || product.category === category;
      const matchesSearch =
        normalizedSearch.length === 0 ||
        `${product.name} ${product.category} ${product.description}`.toLowerCase().includes(normalizedSearch);
      return matchesCategory && matchesSearch && product.stock > 0;
    });
  }, [category, products, search]);

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function addToCart(product: Product) {
    if (gcashOrder) return;
    setNotice("");
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock) {
          setNotice("That’s all we have in stock for this item.");
          return current;
        }
        return current.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...current, { product, quantity: 1 }];
    });
  }

  function adjustCart(productId: string, delta: number) {
    if (gcashOrder) return;
    setCart((current) =>
      current
        .map((line) =>
          line.product.id === productId
            ? { ...line, quantity: Math.min(line.product.stock, line.quantity + delta) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  async function startCheckout() {
    if (!cart.length || checkoutBusy) return;
    setCheckoutBusy(true);
    setNotice("");
    try {
      const result = await apiRequest<{
        cash_order?: boolean;
        manual_gcash_order?: boolean;
        reference?: string;
        amount?: number;
        gcash_number?: string;
        submission_token?: string;
      }>("checkout", {
        method: "POST",
        body: JSON.stringify({
          payment_method: paymentMethod,
          items: cart.map(({ product, quantity }) => ({ id: product.id, quantity })),
        }),
      });
      if (paymentMethod === "cash" && result.cash_order) {
        setCart([]);
        setNotice("Cash order placed! Please pay at the store counter when you pick up your items.");
        await loadProducts();
      } else if (paymentMethod === "gcash" && result.manual_gcash_order && result.reference
          && result.amount && result.gcash_number && result.submission_token) {
        setGcashOrder({
          reference: result.reference,
          amount: result.amount,
          gcash_number: result.gcash_number,
          submission_token: result.submission_token,
        });
        setNotice("");
      } else {
        throw new Error("The checkout response was incomplete. Please try again.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to complete checkout.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function submitGcashPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gcashOrder || checkoutBusy) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const reference = formData.get("gcash_reference");
    const receipt = formData.get("receipt");
    if (!(receipt instanceof File) || receipt.size === 0) {
      setNotice("Choose a screenshot of your GCash receipt.");
      return;
    }
    if (receipt.size > 2 * 1024 * 1024) {
      setNotice("Receipt images must be no larger than 2 MB.");
      return;
    }

    setCheckoutBusy(true);
    setNotice("");
    try {
      const receiptDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("The receipt image could not be read."));
        reader.onerror = () => reject(new Error("The receipt image could not be read."));
        reader.readAsDataURL(receipt);
      });
      await apiRequest("submit_gcash_payment", {
        method: "POST",
        body: JSON.stringify({
          transaction_id: gcashOrder.reference,
          submission_token: gcashOrder.submission_token,
          gcash_reference: String(reference ?? ""),
          receipt_data_url: receiptDataUrl,
        }),
      });
      setCart([]);
      setGcashOrder(null);
      form.reset();
      setNotice(`Your GCash reference and receipt for order ${gcashOrder.reference} were sent to the store. The admin will verify the payment before confirming your order.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Your receipt could not be submitted.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest<{ csrf_token: string }>("login", {
        method: "POST",
        body: JSON.stringify({
          username: String(form.get("username") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });
      setCsrfToken(result.csrf_token);
      setIsAdmin(true);
      setShowLogin(false);
      await loadAdmin();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Unable to sign in.");
    }
  }

  async function handleLogout() {
    try {
      await apiRequest("logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
      });
    } finally {
      setIsAdmin(false);
      setAdmin(null);
      setCsrfToken("");
      await loadProducts();
    }
  }

  async function submitAdminAction(action: string, form: HTMLFormElement) {
    const formData = new FormData(form);
    setAdminError("");
    try {
      await apiRequest(action, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(Object.fromEntries(formData.entries())),
      });
      form.reset();
      await loadAdmin();
      setNotice("Saved successfully.");
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "The change could not be saved.");
    }
  }

  const groupedProducts = visibleProducts.reduce<Record<string, Product[]>>((groups, product) => {
    (groups[product.category] ??= []).push(product);
    return groups;
  }, {});

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Aiza Gabutan Chang's Store home">
          <span className="brand-mark">A</span>
          <span className="brand-copy">
            <strong>Aiza's Store</strong>
            <small>your friendly neighborhood tindahan</small>
          </span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#shop">Shop</a>
          <a href="#about">About us</a>
          {!DEMO_MODE && <button className="nav-login" onClick={() => setShowLogin(true)}>Admin login</button>}
          {!DEMO_MODE && isAdmin && <button className="nav-admin" onClick={() => void loadAdmin()}>Dashboard</button>}
        </nav>
        <a className="cart-pill" href="#basket" aria-label={`Basket with ${cartCount} items`}>
          <span aria-hidden="true">🛍</span>
          <span>Basket</span>
          <b>{cartCount}</b>
        </a>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button>
        </div>
      )}

      {DEMO_MODE && <div className="demo-banner" role="status">Public demo preview — sample products only; admin login, orders, inventory changes, and payments are disabled.</div>}

      {isAdmin ? (
        <AdminDashboard
          data={admin}
          error={adminError}
          onLogout={() => void handleLogout()}
          onAction={(action, form) => void submitAdminAction(action, form)}
        />
      ) : (
        <>
          <main>
            <section className="hero" id="home">
              <div className="hero-copy">
                <span className="eyebrow"><span className="eyebrow-dot" /> OPEN FOR YOUR EVERYDAY NEEDS</span>
                <h1>A little store.<br /><em>A lot of heart.</em></h1>
                <p>Everyday essentials, merienda favorites, and a warm hello — right here at Aiza Gabutan Chang's Store.</p>
                <a className="primary-button" href="#shop">Find your favorites <span aria-hidden="true">↗</span></a>
                <div className="hero-note"><span>☀️</span> Dito, laging may pang-merienda.</div>
              </div>
              <div className="hero-art" role="img" aria-label="Illustration of a colorful neighborhood sari-sari store">
                <div className="sun-stamp">SARI<br />SARI<br /><small>STORE</small></div>
                <div className="shop-scene">
                  <div className="shop-roof"><span>AIZA'S TINDAHAN</span></div>
                  <div className="shop-awning"><i /><i /><i /><i /><i /><i /></div>
                  <div className="shop-front">
                    <div className="shop-window">
                      <span>☕</span><span>🍪</span><span>🍜</span><span>🥤</span>
                    </div>
                    <div className="shop-door"><span>OPEN</span><i /></div>
                    <div className="shop-counter"><span>🍬</span><span>🍚</span><span>🫙</span><span>🌽</span></div>
                  </div>
                  <div className="shop-step" />
                </div>
                <span className="art-leaf leaf-one">✦</span>
                <span className="art-leaf leaf-two">✿</span>
                <span className="art-caption">MADE WITH<br />A LITTLE LOVE</span>
              </div>
            </section>

            <section className="trust-strip" aria-label="Store features">
              <div><span>🏡</span><p><strong>Your neighborhood store</strong><small>Familiar faces, everyday essentials</small></p></div>
              <div><span>💸</span><p><strong>Presyong kaibigan</strong><small>Everyday prices for everyone</small></p></div>
              <div><span>{DEMO_MODE ? "👀" : "📱"}</span><p><strong>{DEMO_MODE ? "Public demo preview" : "GCash transfers"}</strong><small>{DEMO_MODE ? "Browsing only — no orders or payments" : "Transfer to the store; admin verifies payment"}</small></p></div>
            </section>

            <section className="shop-section" id="shop">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">THE LITTLE EVERYDAY THINGS</span>
                  <h2>What can we get you?</h2>
                  <p>From your morning coffee to your merienda break.</p>
                </div>
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find something..." aria-label="Search products" />
                  <kbd>/</kbd>
                </label>
              </div>

              <div className="category-tabs" aria-label="Filter by category">
                {categories.map((item) => (
                  <button key={item} className={item === category ? "category-tab active" : "category-tab"} onClick={() => setCategory(item)}>{item}</button>
                ))}
              </div>

              {loading ? (
                <div className="empty-state"><span className="loader" /> Getting the shelves ready…</div>
              ) : storeError ? (
                <div className="empty-state error-state"><strong>We couldn’t load the shelves.</strong><span>{storeError}</span><button className="secondary-button" onClick={() => void loadProducts()}>Try again</button></div>
              ) : visibleProducts.length === 0 ? (
                <div className="empty-state"><span>🧺</span><strong>No items found</strong><span>Try another search or category.</span></div>
              ) : (
                Object.entries(groupedProducts).map(([group, items]) => (
                  <div className="product-group" key={group}>
                    <div className="group-title"><h3>{group}</h3><span>{items.length} {items.length === 1 ? "item" : "items"}</span></div>
                    <div className="product-grid">
                      {items.map((product) => (
                        <article className="product-card" key={product.id}>
                          <div className={`product-art art-${product.id.split("-")[0]}`}><span>{product.emoji}</span><small>{product.stock <= 5 ? "LOW STOCK" : "A STORE FAVORITE"}</small></div>
                          <div className="product-info">
                            <div className="product-name-row"><h4>{product.name}</h4><strong>{peso.format(product.price)}</strong></div>
                            <p>{product.description}</p>
                            <button className="add-button" onClick={() => addToCart(product)} disabled={product.stock < 1 || Boolean(gcashOrder)}>
                              <span>＋</span> Add to basket
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </section>

            <section className="basket-section" id="basket">
              <div className="basket-card">
                <div className="basket-title"><div><span className="eyebrow">YOUR LITTLE HAUL</span><h2>Shopping basket <span>{cartCount}</span></h2></div><span className="basket-icon">🛍️</span></div>
                {cart.length === 0 ? (
                  <p className="basket-empty">Your basket is waiting for something good. <a href="#shop">Browse the shelves →</a></p>
                ) : (
                  <>
                    <div className="basket-lines">
                      {cart.map(({ product, quantity }) => (
                        <div className="basket-line" key={product.id}>
                          <span className="basket-item-icon">{product.emoji}</span>
                          <span className="basket-item-name">{product.name}<small>{peso.format(product.price)} each</small></span>
                          <div className="quantity-control">
                            <button aria-label={`Remove one ${product.name}`} onClick={() => adjustCart(product.id, -1)} disabled={Boolean(gcashOrder)}>−</button>
                            <span>{quantity}</span>
                            <button aria-label={`Add one ${product.name}`} onClick={() => adjustCart(product.id, 1)} disabled={Boolean(gcashOrder)}>+</button>
                          </div>
                          <strong>{peso.format(product.price * quantity)}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="basket-total"><span>Total</span><strong>{peso.format(cartTotal)}</strong></div>
                    {DEMO_MODE ? (
                      <p className="demo-checkout-notice">This public preview is for browsing only. No order or payment will be submitted.</p>
                    ) : <>
                    {gcashOrder ? (
                      <form className="gcash-payment-form" onSubmit={(event) => void submitGcashPayment(event)}>
                        <div className="gcash-payment-instructions">
                          <strong>Send {peso.format(gcashOrder.amount)} to GCash</strong>
                          <a href={`tel:${gcashOrder.gcash_number}`}>{gcashOrder.gcash_number}</a>
                          <small>Order reference: {gcashOrder.reference}. After paying, enter the GCash transfer reference number and attach your receipt screenshot.</small>
                        </div>
                        <label>GCash transfer reference number
                          <input name="gcash_reference" autoComplete="off" minLength={4} maxLength={40} pattern="[A-Za-z0-9-]{4,40}" required />
                        </label>
                        <label>Receipt screenshot (JPG, PNG, or WebP; up to 2 MB)
                          <input name="receipt" type="file" accept="image/jpeg,image/png,image/webp" required />
                        </label>
                        <button className="checkout-button" type="submit" disabled={checkoutBusy}>
                          {checkoutBusy ? "Sending receipt..." : "Submit payment details"} <span>→</span>
                        </button>
                        <p className="checkout-caption">Your order remains pending until the store verifies your transfer. Do not send your GCash MPIN or OTP.</p>
                      </form>
                    ) : <>
                    <fieldset className="payment-methods" disabled={checkoutBusy}>
                      <legend>How would you like to pay?</legend>
                      <label className={paymentMethod === "cash" ? "payment-option selected" : "payment-option"}>
                        <input type="radio" name="payment-method" value="cash" checked={paymentMethod === "cash"} onChange={() => setPaymentMethod("cash")} />
                        <span className="payment-icon">💵</span>
                        <span className="payment-copy"><strong>Cash at the store</strong><small>Pay at the counter when you pick up</small></span>
                        <span className="payment-check" aria-hidden="true">✓</span>
                      </label>
                      <label className={paymentMethod === "gcash" ? "payment-option selected" : "payment-option"}>
                        <input type="radio" name="payment-method" value="gcash" checked={paymentMethod === "gcash"} onChange={() => setPaymentMethod("gcash")} />
                        <span className="payment-icon">📱</span>
                        <span className="payment-copy"><strong>GCash transfer</strong><small>Send payment to the store’s GCash number</small></span>
                        <span className="payment-check" aria-hidden="true">✓</span>
                      </label>
                    </fieldset>
                    <button className="checkout-button" onClick={() => void startCheckout()} disabled={checkoutBusy}>
                      {checkoutBusy ? "Preparing your order..." : paymentMethod === "cash" ? "Place cash order" : "Continue with GCash"} <span>→</span>
                    </button>
                    <p className="checkout-caption">{paymentMethod === "cash" ? "Your cash order is confirmed by the store when payment is made at the counter." : "Transfer the total to the store’s GCash number. The store will verify payment before confirming your order."}</p>
                    {paymentMethod === "gcash" && gcashNumber && (
                      <p className="checkout-caption">
                        GCash number: <a href={`tel:${gcashNumber}`}>{gcashNumber}</a>. The transfer reference and receipt upload appear after placing your order.
                      </p>
                    )}
                    </>}
                    </>}
                  </>
                )}
              </div>
            </section>

            <section className="about-section" id="about">
              <div className="about-mark">A<span>✿</span></div>
              <div><span className="eyebrow">A LITTLE ABOUT US</span><h2>More than a store.<br /><em>Part of the neighborhood.</em></h2>
                <p>Aiza Gabutan Chang's Store is a humble sari-sari store bringing daily essentials, snacks, and friendly service to our community. Salamat sa pagdaan — you make our little store feel like home.</p>
                <span className="about-signoff">With warmth, Aiza <span>♥</span></span>
              </div>
            </section>
          </main>
          <footer className="footer"><a className="footer-brand" href="#home">Aiza's Store <span>✿</span></a><span>Everyday needs, with a little extra love.</span><span>© {new Date().getFullYear()} Aiza Gabutan Chang's Store</span></footer>
        </>
      )}

      {!DEMO_MODE && showLogin && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogin(false); }}>
          <section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
            <button className="modal-close" aria-label="Close admin login" onClick={() => setShowLogin(false)}>×</button>
            <div className="login-icon">🔐</div>
            <span className="eyebrow">STORE MANAGEMENT</span>
            <h2 id="login-title">Welcome back, Aiza.</h2>
            <p>Sign in to manage the shelves and see how the store is doing.</p>
            <form onSubmit={(event) => void handleLogin(event)} className="login-form">
              <label>Username<input name="username" autoComplete="username" required /></label>
              <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
              {loginError && <div className="form-error" role="alert">{loginError}</div>}
              <button className="checkout-button" type="submit">Sign in to dashboard <span>→</span></button>
            </form>
            <small className="login-footnote">For authorized store administrators only.</small>
          </section>
        </div>
      )}
    </div>
  );
}

function AdminDashboard({
  data,
  error,
  onLogout,
  onAction,
}: {
  data: AdminData | null;
  error: string;
  onLogout: () => void;
  onAction: (action: string, form: HTMLFormElement) => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "inventory" | "transactions">("overview");
  const [selectedProduct, setSelectedProduct] = useState("");

  useEffect(() => {
    if (!selectedProduct && data?.products[0]) setSelectedProduct(data.products[0].id);
  }, [data, selectedProduct]);

  const lowStock = data?.products.filter((product) => product.stock <= 5) ?? [];
  const editingProduct = data?.products.find((product) => product.id === selectedProduct);

  function exportCsv() {
    if (!data) return;
    const rows = [
      ["Reference", "Type", "Description", "Status", "Payment method", "Amount", "Date"],
      ...data.transactions.map((transaction) => [
        transaction.id,
        transaction.type,
        transaction.description,
        transaction.status,
        transaction.payment_method,
        String(transaction.amount),
        new Date(transaction.created_at).toLocaleString("en-PH"),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "aiza-store-transactions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="admin-shell">
      <div className="admin-topline">
        <div><span className="eyebrow">YOUR STORE AT A GLANCE</span><h1>Store dashboard <span>✿</span></h1><p>Good day, Aiza. Here’s what’s happening at your store.</p></div>
        <button className="secondary-button logout-button" onClick={onLogout}>Sign out</button>
      </div>
      <div className="admin-tabs">
        {(["overview", "inventory", "transactions"] as const).map((tab) => <button key={tab} className={activeTab === tab ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
      </div>
      {error && <div className="form-error admin-error" role="alert">{error}</div>}
      {!data ? <div className="empty-state"><span className="loader" /> Loading your dashboard…</div> : (
        <>
          {activeTab === "overview" && (
            <>
              <div className="stats-grid">
                <StatCard label="Sales today" value={peso.format(data.stats.today_sales)} icon="📈" tint="peach" />
                <StatCard label="All-time sales" value={peso.format(data.stats.total_sales)} icon="🧾" tint="blue" />
                <StatCard label="Cash-in today" value={peso.format(data.stats.cash_in_today)} icon="📲" tint="green" />
                <StatCard label="Cash-out today" value={peso.format(data.stats.cash_out_today)} icon="💸" tint="pink" />
              </div>
              <div className="dashboard-columns">
                <section className="panel">
                  <div className="panel-heading"><div><span className="eyebrow">LATEST ACTIVITY</span><h2>Recent transactions</h2></div><button className="text-button" onClick={() => setActiveTab("transactions")}>See all →</button></div>
                  <TransactionTable transactions={data.transactions.slice(0, 6)} />
                </section>
                <section className="panel">
                  <div className="panel-heading"><div><span className="eyebrow">A LITTLE CHECK-IN</span><h2>Stock to watch</h2></div><span className="panel-icon">📦</span></div>
                  {lowStock.length === 0 ? <p className="quiet-note">All the shelves are looking good.</p> : lowStock.map((product) => <div className="low-stock-row" key={product.id}><span>{product.emoji}</span><div><strong>{product.name}</strong><small>{product.stock} left on the shelf</small></div><span className="stock-badge">{product.stock} left</span></div>)}
                  <p className="stock-footnote">{data.stats.pending_payments} GCash payment{data.stats.pending_payments === 1 ? "" : "s"} awaiting verification. {data.stats.pending_cash_orders} cash order{data.stats.pending_cash_orders === 1 ? "" : "s"} await payment at the counter.</p>
                </section>
              </div>
              {data.stats.pending_cash_orders > 0 && <PendingCashOrders transactions={data.transactions} onAction={onAction} />}
              {data.stats.pending_payments > 0 && <PendingGcashPayments transactions={data.transactions} onAction={onAction} />}
              <section className="panel gcash-settings-panel">
                <div className="panel-heading"><div><span className="eyebrow">CUSTOMER CONTACT</span><h2>GCash contact number</h2></div><span className="panel-icon">📱</span></div>
                <form key={data.gcash_number} className="inline-form gcash-settings-form" onSubmit={(event) => { event.preventDefault(); onAction("update_gcash_number", event.currentTarget); }}>
                  <label>Number shown to customers
                    <input name="gcash_number" type="tel" inputMode="tel" autoComplete="tel" defaultValue={data.gcash_number} pattern="(09[0-9]{9}|[+]639[0-9]{9})" maxLength={13} required />
                  </label>
                  <button className="checkout-button" type="submit">Save contact number</button>
                </form>
                <p className="transactions-note">Customers transfer order payments to this number. Verify each incoming transfer before confirming its order.</p>
              </section>
              <section className="panel admin-operations">
                <div className="panel-heading"><div><span className="eyebrow">AT THE COUNTER</span><h2>Record a store transaction</h2></div><span className="panel-icon">🧾</span></div>
                <div className="operation-grid">
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); onAction("record_sale", event.currentTarget); }}>
                    <h3>Record a cash sale</h3>
                    <label>Item<select name="product_id" required>{data.products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.stock} in stock</option>)}</select></label>
                    <label>Quantity sold<input type="number" name="quantity" min="1" max="100" required /></label>
                    <button className="checkout-button" type="submit">Save sale</button>
                  </form>
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); onAction("cash_in", event.currentTarget); }}>
                    <h3>Record GCash cash-in</h3>
                    <label>Amount in pesos<input name="amount" type="number" min="0.01" max="100000" step="0.01" required /></label>
                    <label>Transaction note<input name="description" maxLength={120} placeholder="e.g. Walk-in cash-in" required /></label>
                    <button className="checkout-button" type="submit">Save cash-in record</button>
                  </form>
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); onAction("cash_out", event.currentTarget); }}>
                    <h3>Record GCash cash-out</h3>
                    <label>Amount in pesos<input name="amount" type="number" min="0.01" max="100000" step="0.01" required /></label>
                    <label>Transaction note<input name="description" maxLength={120} placeholder="e.g. Walk-in cash-out" required /></label>
                    <button className="checkout-button" type="submit">Save cash-out record</button>
                  </form>
                </div>
                <p className="transactions-note">Cash-in and cash-out entries are manual records of service completed at the counter; they do not send money through GCash.</p>
              </section>
            </>
          )}
          {activeTab === "inventory" && (
            <>
              <div className="inventory-actions">
                <section className="panel action-panel"><div className="panel-heading"><div><span className="eyebrow">KEEP THE SHELVES FULL</span><h2>Restock an item</h2></div><span className="panel-icon">📦</span></div>
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); onAction("restock", event.currentTarget); }}>
                    <label>Item<select name="product_id" value={selectedProduct} onChange={(event) => setSelectedProduct(event.target.value)} required>{data.products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.stock} in stock</option>)}</select></label>
                    <label>Quantity to add<input type="number" name="quantity" min="1" max="10000" placeholder="Enter a positive number" required /></label>
                    <button className="checkout-button" type="submit">Add stock</button>
                  </form>
                </section>
                <section className="panel action-panel"><div className="panel-heading"><div><span className="eyebrow">NEW ON THE SHELF</span><h2>Add a product</h2></div><span className="panel-icon">✨</span></div>
                  <form className="inline-form two-column-form" onSubmit={(event) => { event.preventDefault(); onAction("add_product", event.currentTarget); }}>
                    <label>Product name<input name="name" maxLength={80} required /></label>
                    <label>Category (optional)<input name="category" maxLength={50} placeholder="Defaults to Uncategorized" /></label>
                    <label>Price in pesos<input name="price" type="number" min="0.01" max="100000" step="0.01" required /></label>
                    <label>Starting stock (optional)<input name="stock" type="number" min="0" max="100000" placeholder="Defaults to 0" /></label>
                    <label>Emoji (optional)<input name="emoji" maxLength={8} defaultValue="🛒" /></label>
                    <button className="checkout-button" type="submit">Add to inventory</button>
                  </form>
                </section>
              </div>
              <section className="panel inventory-panel"><div className="panel-heading"><div><span className="eyebrow">EVERY ITEM, ACCOUNTED FOR</span><h2>Inventory record</h2></div><span className="inventory-count">{data.products.length} items</span></div>
                <div className="table-scroll"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Manage</th></tr></thead><tbody>{data.products.map((product) => <tr key={product.id}><td><span className="table-product">{product.emoji} <strong>{product.name}</strong></span></td><td>{product.category || "Uncategorized"}</td><td>{peso.format(product.price)}</td><td>{product.stock}</td><td><span className={product.stock <= 5 ? "status-chip status-low" : "status-chip status-good"}>{product.stock <= 5 ? "Restock soon" : "In stock"}</span></td><td><button className="edit-product-button" onClick={() => setSelectedProduct(product.id)}>Edit</button></td></tr>)}</tbody></table></div>
              </section>
              {editingProduct && (
                <section className="panel inventory-panel edit-product-panel">
                  <div className="panel-heading"><div><span className="eyebrow">UPDATE THE SHELF</span><h2>Edit {editingProduct.name}</h2></div><span className="panel-icon">✏️</span></div>
                  <form className="inline-form edit-product-form" key={`${editingProduct.id}-${editingProduct.name}-${editingProduct.category}-${editingProduct.price}-${editingProduct.stock}-${editingProduct.emoji}`} onSubmit={(event) => { event.preventDefault(); onAction("update_product", event.currentTarget); }}>
                    <input type="hidden" name="product_id" value={editingProduct.id} />
                    <label>Product name<input name="name" maxLength={80} defaultValue={editingProduct.name} required /></label>
                    <label>Category (optional)<input name="category" maxLength={50} defaultValue={editingProduct.category} placeholder="Defaults to Uncategorized" /></label>
                    <label>Price in pesos<input name="price" type="number" min="0.01" max="100000" step="0.01" defaultValue={editingProduct.price} required /></label>
                    <label>Stock quantity<input name="stock" type="number" min="0" max="100000" defaultValue={editingProduct.stock} required /></label>
                    <label>Emoji<input name="emoji" maxLength={8} defaultValue={editingProduct.emoji} /></label>
                    <button className="checkout-button" type="submit">Save inventory changes</button>
                  </form>
                </section>
              )}
            </>
          )}
          {activeTab === "transactions" && (
            <>
              {data.stats.pending_cash_orders > 0 && <PendingCashOrders transactions={data.transactions} onAction={onAction} />}
              {data.stats.pending_payments > 0 && <PendingGcashPayments transactions={data.transactions} onAction={onAction} />}
              <section className="panel transactions-panel"><div className="panel-heading"><div><span className="eyebrow">THE STORE'S PAPER TRAIL</span><h2>Transactions & sales</h2></div><button className="secondary-button export-button" onClick={exportCsv}>↓ Export CSV</button></div>
                <p className="transactions-note">Confirm a GCash transfer only after verifying that payment reached the store wallet. Cash orders are recorded as sales only after you receive payment at the counter. Cash-in and cash-out are store records, not automatic wallet transfers.</p>
                <TransactionTable transactions={data.transactions} expanded />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function StatCard({ label, value, icon, tint }: { label: string; value: string; icon: string; tint: string }) {
  return <section className={`stat-card tint-${tint}`}><span className="stat-icon">{icon}</span><span className="stat-label">{label}</span><strong>{value}</strong><small>Recorded by the store</small></section>;
}

function PendingCashOrders({ transactions, onAction }: { transactions: Transaction[]; onAction: (action: string, form: HTMLFormElement) => void }) {
  const orders = transactions.filter((transaction) => transaction.type === "cash_order" && transaction.status === "pending");
  if (orders.length === 0) return null;
  return (
    <section className="panel pending-orders-panel">
      <div className="panel-heading"><div><span className="eyebrow">PAYMENT AT THE COUNTER</span><h2>Cash orders to confirm</h2></div><span className="inventory-count">{orders.length} awaiting payment</span></div>
      <div className="pending-order-list">{orders.map((order) => (
        <div className="pending-order" key={order.id}>
          <div className="pending-order-info"><strong>{order.description}</strong><small>{order.id} · {peso.format(order.amount)} · {new Date(order.created_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}</small></div>
          <div className="pending-order-actions">
            <form onSubmit={(event) => { event.preventDefault(); onAction("confirm_cash_order", event.currentTarget); }}><input type="hidden" name="transaction_id" value={order.id} /><button className="order-confirm-button" type="submit">Confirm cash received</button></form>
            <form onSubmit={(event) => { event.preventDefault(); onAction("cancel_cash_order", event.currentTarget); }}><input type="hidden" name="transaction_id" value={order.id} /><button className="order-cancel-button" type="submit">Cancel order</button></form>
          </div>
        </div>
      ))}</div>
      <p className="transactions-note">Confirm only after the customer has paid. Inventory and sales totals update when you confirm.</p>
    </section>
  );
}

function PendingGcashPayments({ transactions, onAction }: { transactions: Transaction[]; onAction: (action: string, form: HTMLFormElement) => void }) {
  const orders = transactions.filter((transaction) =>
    transaction.type === "payment" && transaction.payment_method === "Manual GCash" && transaction.status === "pending",
  );
  if (orders.length === 0) return null;
  return (
    <section className="panel pending-orders-panel">
      <div className="panel-heading"><div><span className="eyebrow">VERIFY TRANSFERS</span><h2>GCash payments to confirm</h2></div><span className="inventory-count">{orders.length} awaiting verification</span></div>
      <div className="pending-order-list">{orders.map((order) => (
        <div className="pending-order" key={order.id}>
          <div className="pending-order-info"><strong>{order.description}</strong><small>{order.id} · {peso.format(order.amount)} · {new Date(order.created_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}</small></div>
          {order.receipt_required && (
            <div className="pending-gcash-proof">
              <strong>GCash reference: {order.gcash_reference || "Not submitted"}</strong>
              {order.receipt_url
                ? <a href={order.receipt_url} target="_blank" rel="noopener noreferrer">View customer receipt ↗</a>
                : <small>Customer receipt not submitted</small>}
            </div>
          )}
          <div className="pending-order-actions">
            <form onSubmit={(event) => { event.preventDefault(); onAction("confirm_gcash_payment", event.currentTarget); }}><input type="hidden" name="transaction_id" value={order.id} /><button className="order-confirm-button" type="submit" disabled={Boolean(order.receipt_required && (!order.gcash_reference || !order.receipt_url))}>Confirm transfer received</button></form>
            <form onSubmit={(event) => { event.preventDefault(); onAction("cancel_gcash_payment", event.currentTarget); }}><input type="hidden" name="transaction_id" value={order.id} /><button className="order-cancel-button" type="submit">Cancel order</button></form>
          </div>
        </div>
      ))}</div>
      <p className="transactions-note">Verify the transfer in the GCash wallet before confirming. Inventory and sales totals update only after confirmation.</p>
    </section>
  );
}

function TransactionTable({ transactions, expanded = false }: { transactions: Transaction[]; expanded?: boolean }) {
  if (transactions.length === 0) return <div className="table-empty">No transactions yet. They’ll show up here as the store gets going.</div>;
  return <div className="table-scroll"><table><thead><tr><th>Transaction</th><th>Type</th><th>Status</th><th>Amount</th><th>{expanded ? "Date" : "Time"}</th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id}><td><span className="transaction-description">{transaction.description}</span><small className="transaction-reference">{transaction.id}</small></td><td><span className="type-label">{transaction.type.replace("_", " ")}</span></td><td><span className={`status-chip status-${transaction.status}`}>{transaction.status.replace("_", " ")}</span></td><td className="amount-cell">{peso.format(transaction.amount)}</td><td>{new Date(transaction.created_at).toLocaleString("en-PH", expanded ? { dateStyle: "medium", timeStyle: "short" } : { hour: "numeric", minute: "2-digit" })}</td></tr>)}</tbody></table></div>;
}

export default App;
