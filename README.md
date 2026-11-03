# Aiza Gabutan Chang's Store

A small sari-sari store website built with React, TypeScript, CSS, Netlify Functions, and Supabase Postgres.

## What’s included

- A responsive storefront with searchable products, category filters, a basket, and database-backed inventory.
- A checkout choice between cash at the store and manual GCash transfer. An administrator verifies each GCash transfer before confirming the sale and deducting inventory.
- An administrator dashboard for sales, inventory, restocking, manual sales, recorded cash-in/cash-out, and CSV export.
- An administrator-editable GCash number shown to customers during manual transfer checkout.
- Inventory editing for product details and exact stock levels. Category and initial stock are optional when adding a product; omitted values default to `Uncategorized` and zero stock.
- A seed catalog imported into Supabase. Products, transactions, and administrator accounts are stored in the database.

**Manual GCash transfers:** Customers send payment to the displayed store number and include their order reference. The store must verify receipt in its GCash account before confirming the order. The site does not initiate transfers or automatically verify payments.

**Cash checkout:** Selecting cash places an unpaid pickup order. The administrator must receive the cash and confirm the order in the dashboard before the sale and inventory deduction are recorded. Cancel orders that are not completed.

## Requirements

- Node.js 20.19+ (or 22.12+) and npm
- A Supabase project for the database

## Local setup

1. Copy `.env.example` to `.env` and set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to the administrator credentials. Keep `.env` private; it is ignored by Git. No payment-provider credentials are needed for manual GCash transfers.
3. Install the JavaScript dependencies and start the website:

   ```powershell
   npm install
   npm run dev
   ```

4. Open the Vite URL (usually `http://localhost:5173`). The Vite development server supplies the local API, so PHP is not needed for local development.

The local admin username defaults to `AizaStore`. `ADMIN_PASSWORD` is read from the private `.env` file. If you change either value, restart Vite so its development API reloads `.env`. Production admin credentials are managed in Supabase and are separate from these local credentials.

The Vite development API is local-only and stores local changes in `storage/store.json`. The deployed Netlify site uses its server-side function and the Supabase database configured below.

## Netlify and Supabase deployment

The standard Netlify deployment includes the admin dashboard and server-side API. Netlify Functions connect to Supabase; the browser never receives the Supabase service-role key. Supabase Row Level Security is enabled, and database writes are available only to the server function.

1. Create a Supabase project. In its SQL Editor, run migrations [`001_store.sql`](./supabase/migrations/001_store.sql), [`002_gcash_contact.sql`](./supabase/migrations/002_gcash_contact.sql), [`003_manual_gcash_payments.sql`](./supabase/migrations/003_manual_gcash_payments.sql), and [`004_gcash_receipts.sql`](./supabase/migrations/004_gcash_receipts.sql), in order. These create the store tables, seed the sample products and customer-facing GCash number, and add secure admin confirmation and private receipt storage for manual GCash payments. Existing deployments should run migrations 002, 003, and 004.
2. Set up an administrator and import your existing local store data. Copy `.env.setup.example` to `.env.setup`, fill in the Supabase project URL, **service-role** key, and a new admin username and password of at least 12 characters. Quote environment values containing spaces or `#`. The setup script imports `storage/store.json` when it exists; otherwise it imports the sample seed catalog.

   ```powershell
   Copy-Item .env.setup.example .env.setup
   npm.cmd run setup:database
   ```

   Remove `.env.setup` immediately after setup. It contains a powerful server key and the initial admin password; never upload it, commit it, or share it.

   To change or repair the production admin login later, edit `.env.setup` with the Supabase URL, service-role key, and the desired admin username and password, then run:

   ```powershell
   npm.cmd run setup:admin
   ```

   This creates or updates the Supabase `admin_users` account for that username and its password hash without importing or changing products or transactions. Keep the existing username if you only want to reset its password; a different username creates a separate admin account. Production login credentials come from Supabase; changing Netlify environment variables alone does not update the admin account. Remove `.env.setup` after the command completes. No site redeploy is needed.

3. In the Netlify site’s environment-variable settings, add:

   - `SUPABASE_URL` — the project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key. This is server-only; never use it in a `VITE_` variable or browser code.
   Do not prefix the Supabase service-role key with `VITE_`; keep it server-only.
4. From a terminal in the project folder, install/use the Netlify CLI and link your existing Netlify site:

   ```powershell
   npx.cmd netlify-cli login
   npx.cmd netlify-cli link
   ```

   Select the site you want to use. Configure the environment variables in Netlify before deploying. Then run:

   ```powershell
   npx.cmd netlify-cli deploy --build --prod
   ```

   [`netlify.toml`](./netlify.toml) builds with `npm run build`, publishes `dist`, bundles the server function, routes `/api.php` to it, and enables the single-page app fallback. You can also deploy by connecting a Git repository instead of using the CLI.
5. Test `https://your-site.netlify.app/api.php?action=products`, then sign in through **Admin login**. The GCash number can be changed from the dashboard. Confirm a GCash payment only after verifying the transfer reached the store's wallet.

Check the current Netlify and Supabase plan limits before relying on free tiers for business records or payment traffic. Keep independent backups of store data.

### Public browsing-only demo

The static demo intentionally disables admin login, checkout, payments, and inventory edits. Build it separately with:

```powershell
npm.cmd run build:demo
```

It outputs `dist-demo` and does not use the database. Do not publish this output if you want online admin access.

## Manual GCash checkout

Customers choose GCash, place an order, and transfer the displayed total to the store's GCash number. They then submit the GCash transfer reference and a JPG, PNG, or WebP receipt image (up to 2 MB). Receipt images are stored in a private Supabase Storage bucket and shown to administrators through expiring signed links. The order remains pending until an administrator verifies the transfer in the GCash wallet and confirms it in the dashboard. Confirmation deducts inventory and records the sale; cancel orders that are not paid. No PayMongo account, API key, or webhook is required.

## Data, privacy, and local development

Products, inventory changes, sales, cash orders, payment records, and manual cash-in/cash-out entries are persisted in Supabase when used on Netlify. Admin passwords are stored as salted scrypt hashes; active session tokens and CSRF hashes are stored server-side. The initial setup script imports existing products and transactions from `storage/store.json`, if present.

The customer's in-progress basket and search/filter choices remain in the browser; the app does not collect customer names or contact details. Submitted GCash orders include the transfer reference and receipt image. On Netlify, receipt images are kept in a private Supabase Storage bucket; local Vite development stores them in the local `storage/store.json` file.

For local development, `npm run dev` continues to use the local development API and `storage/store.json`. It does not connect to Supabase. To test the deployed database-backed version, deploy to Netlify and test the public site. The service-role key must remain in Netlify's server-side environment settings.
