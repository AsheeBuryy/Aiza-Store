<?php
declare(strict_types=1);

const STORE_DATA_FILE = dirname(__DIR__) . '/storage/store.json';
const STORE_SEED_FILE = __DIR__ . '/seed.json';

function loadDotEnv(): void
{
    $file = dirname(__DIR__) . '/.env';
    if (!is_file($file) || !is_readable($file)) {
        return;
    }

    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }

        [$name, $value] = explode('=', $line, 2);
        $name = trim($name);
        $value = trim($value);
        if ($name !== '' && getenv($name) === false) {
            putenv($name . '=' . trim($value, "\"'"));
        }
    }
}

function respond(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }

    $body = json_decode($raw, true);
    if (!is_array($body)) {
        respond(400, ['error' => 'Please send a valid JSON request.']);
    }
    return $body;
}

function ensureStoreFile(): void
{
    $directory = dirname(STORE_DATA_FILE);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create the store data directory.');
    }
    if (!is_file(STORE_DATA_FILE) && !copy(STORE_SEED_FILE, STORE_DATA_FILE)) {
        throw new RuntimeException('Unable to initialize store data from the seed file.');
    }
    if (!chmod(STORE_DATA_FILE, 0600)) {
        throw new RuntimeException('Unable to secure the store data file.');
    }
}

function withStore(callable $callback): mixed
{
    ensureStoreFile();
    $file = fopen(STORE_DATA_FILE, 'c+');
    if ($file === false) {
        throw new RuntimeException('Unable to open the store data file.');
    }

    try {
        if (!flock($file, LOCK_EX)) {
            throw new RuntimeException('Unable to lock store data.');
        }
        rewind($file);
        $contents = stream_get_contents($file);
        $state = is_string($contents) && $contents !== '' ? json_decode($contents, true) : null;
        if (!is_array($state) || !isset($state['products'], $state['transactions'])) {
            throw new RuntimeException('The store data file is invalid.');
        }
        $state['gcash_number'] ??= '09302846922';

        $result = $callback($state);
        rewind($file);
        if (!ftruncate($file, 0)) {
            throw new RuntimeException('Unable to update the store data file.');
        }
        $encoded = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $output = $encoded . PHP_EOL;
        if (!is_string($encoded) || fwrite($file, $output) !== strlen($output) || !fflush($file)) {
            throw new RuntimeException('Unable to save store data.');
        }
        return $result;
    } finally {
        flock($file, LOCK_UN);
        fclose($file);
    }
}

function envValue(string $key, string $default = ''): string
{
    $value = getenv($key);
    return $value === false ? $default : trim($value);
}

function startAdminSession(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('aiza_store_session');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function requireAdmin(): void
{
    startAdminSession();
    if (empty($_SESSION['admin'])) {
        respond(401, ['error' => 'Please sign in to manage the store.']);
    }
}

function requireCsrf(): void
{
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($token) || empty($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $token)) {
        respond(403, ['error' => 'Your session has expired. Please sign in again.']);
    }
}

function assertSameOrigin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return;
    }
    $originHost = parse_url($origin, PHP_URL_HOST);
    $requestHost = explode(':', $_SERVER['HTTP_HOST'] ?? '', 2)[0];
    if (!is_string($originHost) || !hash_equals(strtolower($requestHost), strtolower($originHost))) {
        respond(403, ['error' => 'This request did not come from the store website.']);
    }
}

function enforceLoginRateLimit(bool $reset = false): void
{
    $directory = dirname(STORE_DATA_FILE);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create the private storage directory.');
    }
    $file = fopen($directory . '/login-attempts.json', 'c+');
    if ($file === false || !flock($file, LOCK_EX)) {
        throw new RuntimeException('Unable to access login rate-limit data.');
    }
    try {
        rewind($file);
        $content = stream_get_contents($file);
        $attempts = is_string($content) && $content !== '' ? json_decode($content, true) : [];
        if (!is_array($attempts)) {
            throw new RuntimeException('Login rate-limit data is invalid.');
        }
        $clientKey = hash('sha256', (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
        $recent = array_values(array_filter(
            $attempts[$clientKey] ?? [],
            static fn(mixed $time): bool => is_int($time) && $time > time() - 900
        ));
        if (!$reset && count($recent) >= 8) {
            respond(429, ['error' => 'Too many sign-in attempts. Please wait 15 minutes and try again.']);
        }
        $attempts[$clientKey] = $reset ? [] : [...$recent, time()];
        rewind($file);
        $encoded = json_encode($attempts, JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded) || !ftruncate($file, 0) || fwrite($file, $encoded) !== strlen($encoded) || !fflush($file)) {
            throw new RuntimeException('Unable to save login rate-limit data.');
        }
    } finally {
        flock($file, LOCK_UN);
        fclose($file);
    }
}

function requirePost(): array
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        header('Allow: POST');
        respond(405, ['error' => 'This action requires a POST request.']);
    }
    return requestBody();
}

function safeId(string $prefix): string
{
    return strtoupper($prefix) . '-' . strtoupper(bin2hex(random_bytes(5)));
}

function transactionIndex(array $state, string $id): ?int
{
    foreach ($state['transactions'] as $index => $transaction) {
        if (($transaction['checkout_id'] ?? '') === $id || ($transaction['id'] ?? '') === $id) {
            return $index;
        }
    }
    return null;
}

function todayTransactions(array $transactions): array
{
    $today = date('Y-m-d');
    return array_filter($transactions, static fn(array $transaction): bool =>
        substr((string)($transaction['created_at'] ?? ''), 0, 10) === $today
    );
}

function adminPayload(array $state): array
{
    $today = todayTransactions($state['transactions']);
    $sales = static fn(array $transaction): bool =>
        in_array($transaction['type'] ?? '', ['sale', 'payment', 'cash_order'], true)
        && in_array($transaction['status'] ?? '', ['paid', 'paid_stock_issue'], true);

    return [
        'products' => $state['products'],
        'transactions' => array_reverse($state['transactions']),
        'gcash_number' => $state['gcash_number'],
        'stats' => [
            'today_sales' => round(array_sum(array_map(static fn(array $transaction): float => $sales($transaction) ? (float)$transaction['amount'] : 0.0, $today)), 2),
            'total_sales' => round(array_sum(array_map(static fn(array $transaction): float => $sales($transaction) ? (float)$transaction['amount'] : 0.0, $state['transactions'])), 2),
            'cash_in_today' => round(array_sum(array_map(static fn(array $transaction): float => ($transaction['type'] ?? '') === 'cash_in' ? (float)$transaction['amount'] : 0.0, $today)), 2),
            'cash_out_today' => round(array_sum(array_map(static fn(array $transaction): float => ($transaction['type'] ?? '') === 'cash_out' ? (float)$transaction['amount'] : 0.0, $today)), 2),
            'low_stock_count' => count(array_filter($state['products'], static fn(array $product): bool => (int)$product['stock'] <= 5)),
            'pending_payments' => count(array_filter($state['transactions'], static fn(array $transaction): bool => ($transaction['type'] ?? '') === 'payment' && ($transaction['payment_method'] ?? '') === 'Manual GCash' && ($transaction['status'] ?? '') === 'pending')),
            'pending_cash_orders' => count(array_filter($state['transactions'], static fn(array $transaction): bool => ($transaction['type'] ?? '') === 'cash_order' && ($transaction['status'] ?? '') === 'pending')),
        ],
    ];
}

function findProduct(array &$state, string $id): ?array
{
    foreach ($state['products'] as $index => $product) {
        if (($product['id'] ?? '') === $id) {
            return [$index, $product];
        }
    }
    return null;
}

function verifyPaymongoWebhook(string $rawBody): void
{
    $secret = envValue('PAYMONGO_WEBHOOK_SECRET');
    $signatureHeader = $_SERVER['HTTP_PAYMONGO_SIGNATURE'] ?? '';
    if ($secret === '' || !is_string($signatureHeader) || $signatureHeader === '') {
        respond(503, ['error' => 'The PayMongo webhook is not configured.']);
    }

    $parts = [];
    foreach (explode(',', $signatureHeader) as $part) {
        [$key, $value] = array_pad(explode('=', trim($part), 2), 2, '');
        if ($key !== '') {
            $parts[$key] = $value;
        }
    }
    $timestamp = $parts['t'] ?? '';
    $mode = strtolower(envValue('PAYMONGO_MODE', 'test'));
    $providedSignature = $parts[$mode === 'live' ? 'li' : 'te'] ?? '';
    if (!ctype_digit($timestamp) || abs(time() - (int)$timestamp) > 300 || $providedSignature === '') {
        respond(400, ['error' => 'The webhook signature is invalid or expired.']);
    }
    $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    if (!hash_equals($expected, $providedSignature)) {
        respond(400, ['error' => 'The webhook signature is invalid or expired.']);
    }
}

loadDotEnv();
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Frame-Options: DENY');

$action = $_GET['action'] ?? '';
if (!is_string($action)) {
    respond(400, ['error' => 'Invalid action.']);
}

try {
    if ($action === 'products' && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        $store = withStore(static fn(array &$state): array => [
            'products' => $state['products'],
            'gcash_number' => $state['gcash_number'],
        ]);
        respond(200, $store);
    }

    if ($action === 'login') {
        assertSameOrigin();
        $body = requirePost();
        enforceLoginRateLimit();
        $username = envValue('ADMIN_USERNAME');
        $password = envValue('ADMIN_PASSWORD');
        if ($username === '' || $password === '') {
            respond(503, ['error' => 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD on the server.']);
        }
        if (!is_string($body['username'] ?? null) || !is_string($body['password'] ?? null)
            || !hash_equals($username, $body['username']) || !hash_equals($password, $body['password'])) {
            usleep(500000);
            respond(401, ['error' => 'That username and password do not match.']);
        }
        enforceLoginRateLimit(true);
        startAdminSession();
        session_regenerate_id(true);
        $_SESSION['admin'] = true;
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
        respond(200, ['csrf_token' => $_SESSION['csrf_token']]);
    }

    if ($action === 'webhook') {
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
            header('Allow: POST');
            respond(405, ['error' => 'This webhook requires a POST request.']);
        }
        $rawBody = file_get_contents('php://input');
        if (!is_string($rawBody)) {
            respond(400, ['error' => 'Webhook body is unavailable.']);
        }
        verifyPaymongoWebhook($rawBody);
        $event = json_decode($rawBody, true);
        $eventType = $event['data']['attributes']['type'] ?? '';
        $checkout = $event['data']['attributes']['data'] ?? [];
        $checkoutId = $checkout['id'] ?? '';
        $checkoutStatus = $checkout['attributes']['status'] ?? '';
        if (!is_string($checkoutId) || $checkoutId === '') {
            respond(400, ['error' => 'Webhook does not contain a checkout session.']);
        }
        $paidEvent = in_array($eventType, ['checkout_session.payment.paid', 'checkout_session.payment.paid.v2'], true)
            || ($eventType === 'payment.paid' && $checkoutStatus === 'paid');
        $failedEvent = in_array($eventType, ['checkout_session.payment.failed', 'checkout_session.expired'], true);
        if (!$paidEvent && !$failedEvent) {
            respond(200, ['received' => true]);
        }
        $updated = withStore(static function (array &$state) use ($checkoutId, $paidEvent): bool {
            $index = transactionIndex($state, $checkoutId);
            if ($index === null) {
                return false;
            }
            $transaction = &$state['transactions'][$index];
            if ($transaction['status'] !== 'pending') {
                return true;
            }
            if (!$paidEvent) {
                $transaction['status'] = 'failed';
                return true;
            }
            $canFulfill = true;
            foreach ($transaction['items'] as $item) {
                $found = findProduct($state, $item['id']);
                if ($found === null || $state['products'][$found[0]]['stock'] < $item['quantity']) {
                    $canFulfill = false;
                    break;
                }
            }
            $transaction['status'] = $canFulfill ? 'paid' : 'paid_stock_issue';
            $transaction['confirmed_at'] = date(DATE_ATOM);
            if ($canFulfill) {
                foreach ($transaction['items'] as $item) {
                    $found = findProduct($state, $item['id']);
                    $state['products'][$found[0]]['stock'] -= $item['quantity'];
                }
            }
            return true;
        });
        if (!$updated) {
            error_log('Verified PayMongo webhook refers to an unknown checkout session: ' . $checkoutId);
            respond(404, ['error' => 'Checkout session is not in the store record yet.']);
        }
        respond(200, ['received' => true]);
    }

    if ($action === 'checkout') {
        assertSameOrigin();
        $body = requirePost();
        $paymentMethod = $body['payment_method'] ?? '';
        if (!is_string($paymentMethod) || !in_array($paymentMethod, ['cash', 'gcash'], true)) {
            respond(422, ['error' => 'Choose cash at the store or GCash to continue.']);
        }
        if (!is_array($body['items'] ?? null) || count($body['items']) < 1 || count($body['items']) > 30) {
            respond(422, ['error' => 'Add at least one item to your basket before checkout.']);
        }
        $items = [];
        $totalCents = 0;
        withStore(static function (array &$state) use ($body, &$items, &$totalCents): void {
            $seen = [];
            foreach ($body['items'] as $requested) {
                if (!is_array($requested) || !is_string($requested['id'] ?? null)
                    || !is_int($requested['quantity'] ?? null) || $requested['quantity'] < 1 || $requested['quantity'] > 100) {
                    respond(422, ['error' => 'One of the basket items is invalid.']);
                }
                $id = $requested['id'];
                if (isset($seen[$id])) {
                    respond(422, ['error' => 'Please remove duplicate items from your basket and try again.']);
                }
                $seen[$id] = true;
                $found = findProduct($state, $id);
                if ($found === null) {
                    respond(422, ['error' => 'An item in your basket is no longer available. Please refresh the page.']);
                }
                [$index, $product] = $found;
                if ($requested['quantity'] > $state['products'][$index]['stock']) {
                    respond(422, ['error' => $product['name'] . ' does not have enough stock for this basket.']);
                }
                $amountCents = (int)round((float)$product['price'] * 100);
                $items[] = ['id' => $product['id'], 'name' => $product['name'], 'quantity' => $requested['quantity'], 'unit_price' => (float)$product['price']];
                $totalCents += $amountCents * $requested['quantity'];
            }
        });

        $reference = safeId('AIZA');
        if ($paymentMethod === 'cash') {
            withStore(static function (array &$state) use ($items, $totalCents, $reference): void {
                $state['transactions'][] = [
                    'id' => $reference,
                    'type' => 'cash_order',
                    'status' => 'pending',
                    'amount' => round($totalCents / 100, 2),
                    'description' => 'Cash order (' . count($items) . ' items)',
                    'payment_method' => 'Cash at store',
                    'items' => $items,
                    'created_at' => date(DATE_ATOM),
                ];
            });
            respond(201, ['cash_order' => true, 'reference' => $reference]);
        }

        $gcashNumber = withStore(static fn(array &$state): string => $state['gcash_number']);
        withStore(static function (array &$state) use ($items, $totalCents, $reference): void {
            $state['transactions'][] = [
                'id' => $reference,
                'type' => 'payment',
                'status' => 'pending',
                'amount' => round($totalCents / 100, 2),
                'description' => 'GCash transfer (' . count($items) . ' items)',
                'payment_method' => 'Manual GCash',
                'items' => $items,
                'created_at' => date(DATE_ATOM),
            ];
        });
        respond(201, [
            'manual_gcash_order' => true,
            'reference' => $reference,
            'amount' => round($totalCents / 100, 2),
            'gcash_number' => $gcashNumber,
        ]);
    }

    if ($action === 'admin' && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        requireAdmin();
        $payload = withStore(static fn(array &$state): array => adminPayload($state));
        respond(200, $payload);
    }

    if ($action === 'logout') {
        assertSameOrigin();
        requireAdmin();
        requireCsrf();
        $_SESSION = [];
        session_regenerate_id(true);
        session_destroy();
        respond(200, ['success' => true]);
    }

    $adminActions = ['cash_in', 'cash_out', 'restock', 'add_product', 'update_product', 'record_sale', 'confirm_cash_order', 'cancel_cash_order', 'confirm_gcash_payment', 'cancel_gcash_payment', 'update_gcash_number'];
    if (in_array($action, $adminActions, true)) {
        assertSameOrigin();
        requireAdmin();
        requireCsrf();
        $body = requirePost();

        if (in_array($action, ['confirm_gcash_payment', 'cancel_gcash_payment'], true)) {
            $transactionId = $body['transaction_id'] ?? '';
            if (!is_string($transactionId) || $transactionId === '') {
                respond(422, ['error' => 'Choose a GCash payment to update.']);
            }
            $result = withStore(static function (array &$state) use ($action, $transactionId): array {
                $index = transactionIndex($state, $transactionId);
                if ($index === null
                    || ($state['transactions'][$index]['type'] ?? '') !== 'payment'
                    || ($state['transactions'][$index]['payment_method'] ?? '') !== 'Manual GCash') {
                    return ['error' => 'That manual GCash payment could not be found.', 'status' => 404];
                }
                $transaction = &$state['transactions'][$index];
                if (($transaction['status'] ?? '') !== 'pending') {
                    return ['error' => 'That GCash payment has already been updated.', 'status' => 409];
                }
                if ($action === 'cancel_gcash_payment') {
                    $transaction['status'] = 'cancelled';
                    $transaction['cancelled_at'] = date(DATE_ATOM);
                    return ['success' => true];
                }
                foreach ($transaction['items'] as $item) {
                    $found = findProduct($state, $item['id']);
                    if ($found === null || $state['products'][$found[0]]['stock'] < $item['quantity']) {
                        return ['error' => 'There is not enough stock to confirm this payment. Restock the items or cancel the order.', 'status' => 409];
                    }
                }
                foreach ($transaction['items'] as $item) {
                    $found = findProduct($state, $item['id']);
                    $state['products'][$found[0]]['stock'] -= $item['quantity'];
                }
                $transaction['status'] = 'paid';
                $transaction['confirmed_at'] = date(DATE_ATOM);
                return ['success' => true];
            });
            if (isset($result['error'])) {
                respond($result['status'], ['error' => $result['error']]);
            }
            respond(200, ['success' => true]);
        }

        if ($action === 'update_gcash_number') {
            $submitted = $body['gcash_number'] ?? null;
            if (!is_string($submitted)) {
                respond(422, ['error' => 'Enter a valid Philippine mobile number.']);
            }
            $submitted = preg_replace('/[\s-]/', '', trim($submitted));
            if (is_string($submitted) && preg_match('/^\+639[0-9]{9}$/', $submitted) === 1) {
                $submitted = '0' . substr($submitted, 3);
            }
            if (!is_string($submitted) || preg_match('/^09[0-9]{9}$/', $submitted) !== 1) {
                respond(422, ['error' => 'Enter an 11-digit number starting with 09 or a +63 number.']);
            }
            withStore(static function (array &$state) use ($submitted): void {
                $state['gcash_number'] = $submitted;
            });
            respond(200, ['success' => true]);
        }

        if (in_array($action, ['confirm_cash_order', 'cancel_cash_order'], true)) {
            $transactionId = $body['transaction_id'] ?? '';
            if (!is_string($transactionId) || $transactionId === '') {
                respond(422, ['error' => 'Choose a cash order to update.']);
            }
            $result = withStore(static function (array &$state) use ($action, $transactionId): array {
                $index = transactionIndex($state, $transactionId);
                if ($index === null || ($state['transactions'][$index]['type'] ?? '') !== 'cash_order') {
                    return ['error' => 'That cash order could not be found.', 'status' => 404];
                }
                $transaction = &$state['transactions'][$index];
                if (($transaction['status'] ?? '') !== 'pending') {
                    return ['error' => 'That cash order has already been updated.', 'status' => 409];
                }
                if ($action === 'cancel_cash_order') {
                    $transaction['status'] = 'cancelled';
                    $transaction['cancelled_at'] = date(DATE_ATOM);
                    return ['success' => true];
                }
                foreach ($transaction['items'] as $item) {
                    $product = findProduct($state, $item['id']);
                    if ($product === null || $state['products'][$product[0]]['stock'] < $item['quantity']) {
                        return ['error' => 'There is not enough stock to confirm this order. Restock the items or cancel the order.', 'status' => 409];
                    }
                }
                foreach ($transaction['items'] as $item) {
                    $product = findProduct($state, $item['id']);
                    $state['products'][$product[0]]['stock'] -= $item['quantity'];
                }
                $transaction['status'] = 'paid';
                $transaction['confirmed_at'] = date(DATE_ATOM);
                return ['success' => true];
            });
            if (isset($result['error'])) {
                respond($result['status'], ['error' => $result['error']]);
            }
            respond(200, ['success' => true]);
        }

        if (in_array($action, ['cash_in', 'cash_out'], true)) {
            $amount = filter_var($body['amount'] ?? null, FILTER_VALIDATE_FLOAT);
            $description = trim((string)($body['description'] ?? ''));
            if ($amount === false || $amount <= 0 || $amount > 100000 || strlen($description) < 2 || strlen($description) > 120) {
                respond(422, ['error' => 'Enter a valid amount (up to ₱100,000) and a short transaction note.']);
            }
            withStore(static function (array &$state) use ($action, $amount, $description): void {
                $state['transactions'][] = [
                    'id' => safeId('LEDGER'),
                    'type' => $action,
                    'status' => 'recorded',
                    'amount' => round((float)$amount, 2),
                    'description' => $description,
                    'payment_method' => 'Manual store record',
                    'created_at' => date(DATE_ATOM),
                ];
            });
            respond(201, ['success' => true]);
        }

        if ($action === 'restock') {
            $productId = $body['product_id'] ?? '';
            $quantity = filter_var($body['quantity'] ?? null, FILTER_VALIDATE_INT);
            if (!is_string($productId) || $quantity === false || $quantity < 1 || $quantity > 10000) {
                respond(422, ['error' => 'Enter a restock quantity between 1 and 10,000.']);
            }
            $found = withStore(static function (array &$state) use ($productId, $quantity): bool {
                $product = findProduct($state, $productId);
                if ($product === null) {
                    return false;
                }
                [$index] = $product;
                $state['products'][$index]['stock'] += $quantity;
                return true;
            });
            if (!$found) {
                respond(404, ['error' => 'That product is no longer in the inventory.']);
            }
            respond(200, ['success' => true]);
        }

        if ($action === 'add_product') {
            $name = trim((string)($body['name'] ?? ''));
            $category = trim((string)($body['category'] ?? '')) ?: 'Uncategorized';
            $price = filter_var($body['price'] ?? null, FILTER_VALIDATE_FLOAT);
            $stock = ($body['stock'] ?? '') === '' ? 0 : filter_var($body['stock'], FILTER_VALIDATE_INT);
            $emoji = trim((string)($body['emoji'] ?? '')) ?: '🛒';
            if ($name === '' || strlen($name) > 80 || $category === '' || strlen($category) > 50
                || $price === false || $price <= 0 || $price > 100000 || $stock === false || $stock < 0 || $stock > 100000
                || $emoji === '' || strlen($emoji) > 32) {
                respond(422, ['error' => 'Please enter a product name and a price. Category and starting stock are optional.']);
            }
            $id = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '-', $name) ?? '', '-')) . '-' . strtolower(bin2hex(random_bytes(3)));
            withStore(static function (array &$state) use ($id, $name, $category, $price, $stock, $emoji): void {
                $state['products'][] = ['id' => $id, 'name' => $name, 'category' => $category, 'price' => round((float)$price, 2), 'stock' => $stock, 'emoji' => $emoji, 'description' => 'An everyday store favorite.'];
            });
            respond(201, ['success' => true]);
        }

        if ($action === 'update_product') {
            $productId = $body['product_id'] ?? '';
            $name = trim((string)($body['name'] ?? ''));
            $category = trim((string)($body['category'] ?? '')) ?: 'Uncategorized';
            $price = filter_var($body['price'] ?? null, FILTER_VALIDATE_FLOAT);
            $stock = filter_var($body['stock'] ?? null, FILTER_VALIDATE_INT);
            $emoji = trim((string)($body['emoji'] ?? '')) ?: '🛒';
            if (!is_string($productId) || $productId === '' || $name === '' || strlen($name) > 80
                || strlen($category) > 50 || $price === false || $price <= 0 || $price > 100000
                || $stock === false || $stock < 0 || $stock > 100000 || strlen($emoji) > 32) {
                respond(422, ['error' => 'Please enter a product name, price, and valid stock quantity. Category is optional.']);
            }
            $updated = withStore(static function (array &$state) use ($productId, $name, $category, $price, $stock, $emoji): bool {
                $product = findProduct($state, $productId);
                if ($product === null) {
                    return false;
                }
                [$index] = $product;
                $state['products'][$index]['name'] = $name;
                $state['products'][$index]['category'] = $category;
                $state['products'][$index]['price'] = round((float)$price, 2);
                $state['products'][$index]['stock'] = $stock;
                $state['products'][$index]['emoji'] = $emoji;
                return true;
            });
            if (!$updated) {
                respond(404, ['error' => 'That product is no longer in the inventory.']);
            }
            respond(200, ['success' => true]);
        }

        if ($action === 'record_sale') {
            $productId = $body['product_id'] ?? '';
            $quantity = filter_var($body['quantity'] ?? null, FILTER_VALIDATE_INT);
            if (!is_string($productId) || $quantity === false || $quantity < 1 || $quantity > 100) {
                respond(422, ['error' => 'Choose an item and a valid sale quantity.']);
            }
            $result = withStore(static function (array &$state) use ($productId, $quantity): array {
                $found = findProduct($state, $productId);
                if ($found === null) {
                    return ['error' => 'That product is no longer in the inventory.', 'status' => 404];
                }
                [$index, $product] = $found;
                if ($state['products'][$index]['stock'] < $quantity) {
                    return ['error' => 'There is not enough stock to record this sale.', 'status' => 422];
                }
                $state['products'][$index]['stock'] -= $quantity;
                $state['transactions'][] = [
                    'id' => safeId('SALE'),
                    'type' => 'sale',
                    'status' => 'paid',
                    'amount' => round((float)$product['price'] * $quantity, 2),
                    'description' => $product['name'] . ' × ' . $quantity,
                    'payment_method' => 'Cash',
                    'created_at' => date(DATE_ATOM),
                ];
                return ['success' => true];
            });
            if (isset($result['error'])) {
                respond($result['status'], ['error' => $result['error']]);
            }
            respond(201, ['success' => true]);
        }
    }

    respond(404, ['error' => 'That store action was not found.']);
} catch (Throwable $error) {
    error_log('Aiza Store API error: ' . $error->getMessage());
    respond(500, ['error' => 'The store could not complete that request. Please try again.']);
}
