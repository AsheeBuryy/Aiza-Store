# Aiza Gabutan Chang's Store

A small sari-sari store website built with React, TypeScript, CSS, PHP, and a JSON-backed API.

## What’s included

- A responsive storefront with searchable products, category filters, a basket, and PHP-backed inventory.
- A checkout choice between cash at the store and PayMongo-hosted GCash. Cash orders remain pending until the administrator confirms payment at the counter; GCash orders are confirmed only by a signed PayMongo webhook.
- An administrator dashboard for sales, inventory, restocking, manual sales, recorded cash-in/cash-out, and CSV export.
- Inventory editing for product details and exact stock levels. Category and initial stock are optional when adding a product; omitted values default to `Uncategorized` and zero stock.
- A JSON seed catalog. The live JSON store is created on first API use and is excluded from version control.

**GCash service limitation:** PayMongo checkout collects payment for store purchases. The cash-in and cash-out screens record the store's walk-in service in its ledger; they do not initiate or confirm transfers inside a customer's GCash wallet. Do not advertise those records as wallet transfers.

**Cash checkout:** Selecting cash places an unpaid pickup order. The administrator must receive the cash and confirm the order in the dashboard before the sale and inventory deduction are recorded. Cancel orders that are not completed.

## Requirements

- Node.js 20.19+ (or 22.12+) and npm
- PHP 8.1 or newer
- A PayMongo merchant account with GCash enabled for checkout
- A publicly reachable HTTPS URL for the PayMongo webhook in production

## Local setup

1. Copy `.env.example` to `.env`. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to the administrator credentials. Keep `.env` private; it is ignored by Git.
2. Add the PayMongo secret API key and webhook signing secret to `.env`. Use test keys first:

   ```dotenv
   APP_URL=http://localhost:5173
   ADMIN_USERNAME=AizaStore
   ADMIN_PASSWORD=choose-a-strong-unique-password
   PAYMONGO_SECRET_KEY=sk_test_your_key
   PAYMONGO_WEBHOOK_SECRET=whsk_your_webhook_signing_secret
   PAYMONGO_MODE=test
   ```

   Never put PayMongo secret keys in React, browser storage, or a public repository. The administrator password is read only by PHP and is never shipped to the browser.
3. Install the JavaScript dependencies and start the website:

   ```powershell
   npm install
   npm run dev
   ```

4. Open the Vite URL (usually `http://localhost:5173`). The Vite development server supplies the local API, so PHP is not needed for local development.

The admin username defaults to `AizaStore`. `ADMIN_PASSWORD` is read from the private `.env` file. Rotate it before production use. If you change either value, restart Vite so its development API reloads `.env`.

For production, deploy the PHP API documented below; the Vite development API is for local development only.

## PayMongo setup

Configure a PayMongo webhook to send events to `https://your-domain.example/api.php?action=webhook`. Set its signing secret as `PAYMONGO_WEBHOOK_SECRET`; set `PAYMONGO_MODE` to `test` or `live` to match the webhook. The webhook must be reachable over HTTPS in production. Checkout stays disabled with a clear message until the secret key is configured.

The API creates a PayMongo Checkout Session with GCash as the payment method. Treat the browser's success redirect as a status page only; the signed webhook is the source of truth for marking the transaction paid. Verify your PayMongo merchant's enabled payment methods, event names, and webhook configuration in its current dashboard before going live.

## Data and deployment

The first API request initializes `storage/store.json` from `backend/seed.json`. The private `storage` directory is outside the PHP document root; back up this JSON file regularly. The built-in PHP server is for local development, not production. For a small deployment, build the site with `npm run build`, serve `dist` as the web root with PHP enabled for `dist/api.php`, and keep the project-level `.env`, `backend`, and `storage` alongside (not inside the public web root). Use HTTPS and a durable database with operational monitoring for real business use.
