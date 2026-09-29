'use strict';

/*
 * Challenge catalogue — 40 challenges across 4 difficulty tiers (10 each).
 *
 * Points scale with difficulty: easy 10, medium 25, hard 40, insane 60.
 * `title` + `description` are spoiler-free (they hint at the area only). Hints
 * are progressive: the first is always free, later ones cost points that scale
 * with the tier. The server only ever sends a team the hint texts it has paid
 * to unlock.
 */

const POINTS = { easy: 10, medium: 25, hard: 40, insane: 60 };
// Bonus for the first team to solve ANY challenge in a difficulty tier.
const FIRST_BLOOD = { easy: 5, medium: 10, hard: 20, insane: 30 };
const TIER_ORDER = ['easy', 'medium', 'hard', 'insane'];
// Hint cost ladders per tier (index 0 is always free).
const H = {
  easy: [0, 3, 5],
  medium: [0, 5, 10],
  hard: [0, 8, 15],
  insane: [0, 10, 20],
};

function ch(difficulty, id, title, description, hintTexts) {
  const costs = H[difficulty];
  return {
    id,
    difficulty,
    points: POINTS[difficulty],
    title,
    description,
    hints: hintTexts.map((text, i) => ({ cost: costs[i], text })),
  };
}

const CHALLENGES = [
  // ===================== EASY (10 pts) =====================
  ch('easy', 'debug-config-exposed', 'Left the Lights On',
    'Developers leave things behind. Go looking for what should never have shipped.',
    ['Not every endpoint on the server was meant for customers.',
     'Something "debug" shaped was left switched on.',
     'Requesting /api/debug/config spills the server’s secrets.']),

  ch('easy', 'broken-access-control-header', 'Staff Only',
    'The back office is for employees. But the sign on the door is only a sign.',
    ['How does the shop decide that you are allowed into staff areas?',
     'It believes something that the client itself provides on each request.',
     'A request header announces your role. Nothing stops you setting it.']),

  ch('easy', 'idor-order', "Someone Else's Mail",
    'Orders are private. At least, that is the idea.',
    ['Every order has a number, and numbers are easy to guess.',
     'When you fetch an order, nobody checks whether it belongs to you.',
     'Change the id when retrieving an order and read one that is not yours.']),

  ch('easy', 'idor-user-record', 'Know Thy Neighbour',
    'A profile holds more than just a friendly name.',
    ['You can look up your own account. What about the ones around it?',
     'The account lookup hands back everything stored for that person.',
     'Request another user’s id; the reply includes their secret answer and hash.']),

  ch('easy', 'coupon-negative-total', 'A Very Good Deal',
    'Discounts here are generous. Perhaps generous enough that the shop ends up owing you.',
    ['Coupons pull the total down. Ask yourself whether there is a floor.',
     'The larger percentage codes add up quickly against a small basket.',
     'The discount comes from a stored formula and is never clamped — go below zero.']),

  ch('easy', 'reflected-xss-search', 'Echo Chamber',
    'The search box is remarkably good at repeating whatever you tell it.',
    ['Watch what the results page does with your exact words.',
     'Your query is echoed back onto the page as-is.',
     'Search for markup such as an <img> with an error handler and it runs.']),

  ch('easy', 'forced-browsing-robots', 'Nothing to See Here',
    "Some doors aren't linked anywhere in the shop. That doesn't mean they're locked.",
    ['Well-behaved crawlers are told where not to look. You are not a crawler.',
     'Check the file that tells robots which paths to avoid.',
     'Read /robots.txt, then visit the path it tries to hide.']),

  ch('easy', 'default-credentials', 'Out of the Box',
    'Some accounts ship with placeholder passwords that nobody ever changed.',
    ['Think about accounts that come with the system, not real customers.',
     'A support account exists with a painfully common password.',
     "Sign in as support@vinylvault.test with the password 'changeme'."]),

  ch('easy', 'price-tampering', 'Name Your Price',
    'When you check out, how much does the shop really trust your basket?',
    ['Look closely at what the checkout request says about each item.',
     'The server believes the prices your client hands it.',
     "Send an order where an item's price is set far below the sticker price."]),

  ch('easy', 'negative-quantity', 'Less Than Nothing',
    'Quantities go up. Can they go down past zero?',
    ["What happens to a total if a quantity isn't positive?",
     'Nothing stops a negative amount sitting in your basket.',
     'Order a negative quantity to push money back your way.']),

  // ===================== MEDIUM (25 pts) =====================
  ch('medium', 'sqli-search-internal-product', 'Off the Shelf',
    "Not every record makes it to the shop floor. Something's kept in the back — can you make it show itself?",
    ["The catalogue and the search box don't treat the inventory the same way.",
     'Try feeding the search box input it clearly was not expecting.',
     'Your search text is placed inside a query. Close the string and add a condition.']),

  ch('medium', 'sqli-login-bypass', 'The Backdoor Key',
    'The front door has a lock. Locks can be picked without the original key.',
    ["You don't always need the right password — sometimes just the right way to ask.",
     'The login form speaks to the database; one field is more trusting than the other.',
     'The email field is concatenated into the query. A comment and an always-true clause drop the password check.']),

  ch('medium', 'stored-xss-review', 'Leave a Note',
    'Customers can say what they think about a record. The shop listens — maybe too literally.',
    ['Think about where your words end up later, and whose screen they land on.',
     'A review is shown back exactly as written, to everyone who views that record.',
     'A review body is rendered as-is — markup and anything it carries will run.']),

  ch('medium', 'mass-assignment-register-admin', 'Fresh Start, Big Title',
    'New accounts start out humble. Or do they have to?',
    ['The sign-up form shows only a few fields. The server may accept more.',
     'Something on your account decides whether you count as staff.',
     'Send an extra field the form never displays when you create your account.']),

  ch('medium', 'mass-assignment-profile-admin', 'Promotion',
    'You are allowed to edit your profile. The question is how much of it.',
    ['Saving your profile sends your details to the server. Which details, exactly?',
     'The update trusts whatever fields arrive with it.',
     'Include the field that governs your privileges when you save your profile.']),

  ch('medium', 'path-traversal-download', 'Reading Between the Folders',
    'The shop lets you download a few documents. Only a few were meant for you.',
    ['The download picks a file by name. What if you asked for a different name?',
     'That file sits inside a folder, and folders always have a parent.',
     'Use ../ to climb out of the download directory and reach source or system files.']),

  ch('medium', 'insecure-upload-active-content', 'Say Cheese',
    'Upload a profile picture. Any picture. In fact, almost any file at all.',
    ['Consider what kinds of files the uploader is willing to accept.',
     'Whatever you upload is served straight back from the website afterwards.',
     'Upload an .html or .svg containing a script, then open it from /uploads/.']),

  ch('medium', 'order-by-injection', 'Sort It Out',
    'The catalogue can be reordered a dozen ways. The shop builds that ordering from your request.',
    ["It's still a database doing the sorting, and you choose the column.",
     'The sort parameter is dropped into the query past the usual quotes.',
     'Inject into the ORDER BY (a CASE or subquery) to control results or force errors.']),

  ch('medium', 'idor-invoice', 'Paper Trail',
    'Every purchase gets an invoice. Invoices are just files with numbers.',
    ['Invoices are fetched by a number you can change.',
     'No check ties an invoice to the person asking for it.',
     "Request an invoice id that isn't yours to read someone else's purchase."]),

  ch('medium', 'open-redirect', 'Follow the Sign',
    'The shop is happy to forward you onwards. Onwards to where, exactly?',
    ['Some links bounce you through the server to another address.',
     'The destination comes straight from a parameter you control.',
     'Point the redirect at an external site to prove it forwards anywhere.']),

  // ===================== HARD (40 pts) =====================
  ch('hard', 'weak-password-reset', 'Forgot Something?',
    'Locked out of an account? The shop is happy to help you back in. Unfortunately, it will help anyone.',
    ['Recovery leans on a personal question. Where might that answer already be lying around?',
     'This one builds on another challenge that leaks a user’s secret answer.',
     'Leak the target’s security answer via the profile disclosure, then complete the reset.']),

  ch('hard', 'jwt-weak-secret-forge', 'Guess the Signature',
    'Your session ticket is signed with a key. Keys can be weak.',
    ['The token is properly signed — but with what?',
     'The signing secret is short, guessable, and not exactly kept secret.',
     'Find the HS256 secret (it is committed in the source), sign your own admin token, and use it.']),

  ch('hard', 'blind-sqli-user-enum', 'Twenty Questions',
    'One endpoint only ever answers yes or no. That can be enough.',
    ['A yes/no answer that depends on the database can still leak it, one bit at a time.',
     'The check is injectable even though it never shows you any data.',
     'Use a boolean condition in the input so the yes/no reveals rows bit by bit.']),

  ch('hard', 'ssrf-cover-art', 'Phone Home',
    'Import cover art from anywhere on the web, the shop says. Anywhere?',
    ['The server fetches the URL you give it — from the server’s own vantage point.',
     "Server-side, 'localhost' and link-local addresses mean something different than to you.",
     'Point the import at an internal address (127.0.0.1 or 169.254.169.254) to reach what you shouldn’t.']),

  ch('hard', 'prototype-pollution', 'Poisoned Well',
    'The shop lets you save a bag of preferences. It trusts the shape of that bag.',
    ['Merging arbitrary keys into an object can touch more than that object.',
     'Some property names are special and shared by every object.',
     'Send a __proto__ key in your preferences to pollute defaults everywhere.']),

  ch('hard', 'coupon-stacking', 'Stack the Deck',
    'One coupon is nice. What about all of them at once?',
    ['The basket may accept more than a single code.',
     'Discounts add up with no ceiling on the total.',
     'Apply several codes together so the combined discount exceeds the price.']),

  ch('hard', 'command-injection', 'Now Playing',
    'A little diagnostics tool checks whether a store server is reachable.',
    ['The tool takes your input and hands it to the operating system.',
     "Shell metacharacters aren't filtered before that happens.",
     'Chain an extra command with ; or | in the host field.']),

  ch('hard', 'second-order-sqli', 'Sleeper Agent',
    'Something you save quietly today may be trusted somewhere dangerous tomorrow.',
    ["The payload isn't used where you enter it — it is used later.",
     'A stored profile field is later dropped into a query unescaped.',
     'Put SQL in your display name, then trigger the report that queries it.']),

  ch('hard', 'csv-formula-injection', 'Spreadsheet Surprise',
    'Export your purchase history to a spreadsheet. What exactly travels into those cells?',
    ['Exported data is opened in a spreadsheet, which treats some text as live formulas.',
     'A cell that starts with the right character stops being text and starts computing.',
     'Put a value beginning with = (e.g. =1+1) into an order address, then export the CSV.']),

  ch('hard', 'insecure-deserialization-cookie', 'Bring Your Own Identity',
    'The shop remembers your preferences in a little token it hands back to you.',
    ["That preferences cookie isn't as opaque as it looks.",
     "It's just encoded data the server decodes and trusts.",
     'Decode the prefs cookie, flip a field to grant yourself privilege, re-encode it.']),

  // ===================== INSANE (60 pts) =====================
  ch('insane', 'jwt-alg-none', 'Sign Here',
    'Your session is a signed ticket. The real question is who bothers to check the signature.',
    ['Your token has three parts. The first one states how it was signed.',
     'What would happen if a token claimed it needed no signature whatsoever?',
     'Forge a token whose header says alg:none, set role to admin, and the server trusts it.']),

  ch('insane', 'ssti', 'Fill in the Blanks',
    'Personalise your order message with placeholders. The server fills them in for you.',
    ['Those placeholders are evaluated on the server, not just substituted.',
     'Whatever expression sits between the markers gets computed.',
     'Put an expression like {{7*7}} in the template and read the result it renders.']),

  ch('insane', 'xxe', 'Old School',
    'The shop still accepts an old catalogue exchange format for bulk imports.',
    ['The import format is XML, and XML can define its own entities.',
     'The parser resolves declarations inside the document, including external ones.',
     'Declare a DOCTYPE with an entity that pulls in a local file, then reference it.']),

  ch('insane', 'sqli-union-users', 'Deep Cut',
    'The back of the catalogue and the back of the database may be closer than they look.',
    ['The search query can be extended to return rows from elsewhere.',
     'Match the column count and types to graft on another table.',
     'UNION SELECT from the users table through search to exfiltrate credentials.']),

  ch('insane', 'jwt-unverified-endpoint', 'Trust Issues',
    'One corner of the shop reads your ticket but never checks the seal.',
    ['Not every endpoint verifies tokens the same way.',
     'This one reads the claims without validating the signature at all.',
     'Send a token with a garbage signature but role admin to the premium endpoint.']),

  ch('insane', 'admin-flag-captured', 'The Vault',
    'Deep in the back office is the thing worth the most. Only a real manager can open it.',
    ["A header trick won't cut it here — the server checks your actual account.",
     'You must genuinely become an admin in the database, not merely claim it in a token.',
     'Escalate for real (e.g. via mass assignment), then open /api/admin/vault.']),

  ch('insane', 'host-header-injection', 'Return to Sender',
    'Password reset links point back to the shop. Who decides where "back" is?',
    ['The reset link is built from how the request thinks it was addressed.',
     'The server trusts the Host header to construct that link.',
     'Spoof the Host header on a reset request so the link points at your server.']),

  ch('insane', 'redos', 'Catastrophe',
    'One input field is validated by a rather over-eager pattern.',
    ['Some regular expressions can be made to do exponential work.',
     'The validator backtracks badly on certain crafted inputs.',
     'Feed the vulnerable field a long, ambiguous string to hang the matcher.']),

  ch('insane', 'cors-credential-theft', 'Open House',
    'The shop is unusually welcoming to requests from other websites.',
    ['Cross-origin rules decide who may read your responses. This shop is generous.',
     'It reflects any origin and still allows credentials.',
     'From a foreign origin, read a credentialed response you never should.']),

  ch('insane', 'jwt-kid-injection', 'Key Confusion',
    'Your token names which key should verify it. The shop looks that key up.',
    ['The token header points at a key by id.',
     'That id is used to fetch the key — via a query.',
     'Inject into the kid so the server verifies your token with a key you control.']),
];

// Short, beginner-friendly primers per vulnerability category (shown on the
// Challenges page in learn/compete mode).
const CATEGORY_PRIMERS = {
  'Access control': 'Access-control flaws let you reach data or actions that should be off-limits. Classic form: an object is fetched by an id or a flag the server never checks you own (IDOR / broken access control).',
  'SQL injection': 'When user input is glued into a SQL query, you can change what the query does — bypass logins, dump other tables, or read hidden rows. Look for quotes, comments (--), OR/UNION.',
  'Cross-site scripting': 'XSS happens when your input is rendered as HTML/JS instead of text, so your markup runs in someone else\u2019s browser. Reflected = echoed back in the response; stored = saved and shown to others.',
  'Information disclosure': 'Apps leak more than they should: debug endpoints, verbose errors, backup files, or paths that aren\u2019t linked but still work (forced browsing).',
  'Authentication': 'Auth flaws let you become someone you\u2019re not: default/shipped passwords, guessable resets, or recovery flows that trust data you can obtain elsewhere.',
  'Business logic': 'No injection needed — the rules themselves are exploitable. Negative quantities, client-set prices, or stacking discounts past 100% all abuse trusted logic.',
  'File handling': 'Reading or writing files by name is risky: ../ climbs out of a folder (path traversal), and accepting arbitrary uploads or exporting raw data (CSV formulas) turns files into a weapon.',
  'Open redirect': 'When a redirect target comes from user input without a allow-list, the app will happily forward victims to an attacker\u2019s site.',
  'JWT & sessions': 'JSON Web Tokens are only as strong as how they\u2019re verified. Weak secrets, alg:none, unverified signatures or key-lookup injection all let you forge an identity.',
  'SSRF': 'Server-Side Request Forgery makes the server fetch a URL you choose — often reaching internal services (localhost, cloud metadata) the outside world can\u2019t.',
  'Injection': 'Untrusted input handed to an interpreter (a shell, a template engine, an XML parser) can execute your commands instead of being treated as data.',
  'Prototype pollution': 'In JavaScript, merging attacker-controlled keys like __proto__ into an object can poison every object\u2019s prototype, changing app behaviour globally.',
  'Deserialization': 'When the server decodes and trusts client-held state (a cookie, a token) without integrity checks, you can tamper with it to change who the app thinks you are.',
  'Server misconfig': 'Misconfigured trust boundaries: honouring the Host/forwarded headers, reflecting any CORS origin with credentials, or using regexes that can be made to hang (ReDoS).',
};

// Per-challenge extras: vuln category, a starter flag, dependencies, an HTTP
// Lab template (payloads left blank on purpose), and a plain-language
// why-it-worked + how-to-fix. `template.headers`/`body` are strings matching the
// Lab inputs; `PAYLOAD` placeholders are for the learner to fill in.
const EXTRA = {
  'debug-config-exposed': { category: 'Information disclosure', starter: true, template: { method: 'GET', url: '/api/debug/config' }, explain: { why: 'A debug endpoint was left mounted in production and returns the server config, including the JWT secret.', fix: 'Never ship debug/diagnostic endpoints; gate them behind auth and strip them from production builds.' } },
  'broken-access-control-header': { category: 'Access control', starter: true, template: { method: 'GET', url: '/api/admin/users', headers: 'X-User-Role: PAYLOAD' }, explain: { why: 'The server decides your privilege from a request header the client fully controls.', fix: 'Derive authorization from the server-side session/verified token, never from a client-supplied header.' } },
  'idor-order': { category: 'Access control', starter: true, template: { method: 'GET', url: '/api/orders/PAYLOAD', headers: 'Authorization: Bearer <your token>' }, explain: { why: 'Orders are fetched by id with no check that the order belongs to you.', fix: 'Enforce an ownership check (order.user_id === session user) on every object lookup.' } },
  'idor-user-record': { category: 'Access control', starter: true, template: { method: 'GET', url: '/api/users/PAYLOAD', headers: 'Authorization: Bearer <your token>' }, explain: { why: 'The user endpoint returns any account\u2019s full record, including secrets, with no ownership check.', fix: 'Scope the lookup to the authenticated user and never return secret fields/hashes.' } },
  'coupon-negative-total': { category: 'Business logic', starter: true, template: { method: 'POST', url: '/api/checkout/apply-coupon', body: '{\n  "total": PAYLOAD,\n  "code": "PAYLOAD"\n}' }, explain: { why: 'Discounts are subtracted with no lower bound, so the total can drop below zero.', fix: 'Clamp totals at 0 and validate coupon math server-side.' } },
  'reflected-xss-search': { category: 'Cross-site scripting', starter: true, template: { method: 'GET', url: '/api/products/search?q=PAYLOAD' }, explain: { why: 'Your query is reflected into the page and rendered as HTML rather than escaped text.', fix: 'Context-aware output encoding; render user input as text, add a CSP.' } },
  'forced-browsing-robots': { category: 'Information disclosure', starter: true, template: { method: 'GET', url: '/robots.txt' }, explain: { why: 'robots.txt advertises a path that is not linked but is still reachable and unprotected.', fix: 'Don\u2019t rely on obscurity; protect sensitive paths with real authorization.' } },
  'default-credentials': { category: 'Authentication', starter: true, template: { method: 'POST', url: '/api/login', body: '{\n  "email": "PAYLOAD",\n  "password": "PAYLOAD"\n}' }, explain: { why: 'A shipped support account still uses its default password.', fix: 'Force a password change on first use; never ship real accounts with default credentials.' } },
  'price-tampering': { category: 'Business logic', template: { method: 'POST', url: '/api/orders', headers: 'Authorization: Bearer <your token>', body: '{\n  "items": [ { "productId": 1, "price": PAYLOAD, "qty": 1 } ]\n}' }, explain: { why: 'Checkout trusts a price sent by the client instead of the catalogue price.', fix: 'Always compute prices server-side from the product id.' } },
  'negative-quantity': { category: 'Business logic', template: { method: 'POST', url: '/api/orders', headers: 'Authorization: Bearer <your token>', body: '{\n  "items": [ { "productId": 1, "qty": PAYLOAD } ]\n}' }, explain: { why: 'Quantities aren\u2019t validated as positive, so a negative amount flips the total.', fix: 'Validate quantity > 0 (and stock) on the server.' } },
  'sqli-search-internal-product': { category: 'SQL injection', template: { method: 'GET', url: '/api/products/search?q=PAYLOAD' }, explain: { why: 'The search term is concatenated into the SQL string, so a condition like OR \'1\'=\'1 changes the result set.', fix: 'Use parameterized queries; never build SQL by string concatenation.' } },
  'sqli-login-bypass': { category: 'SQL injection', template: { method: 'POST', url: '/api/login', body: '{\n  "email": "PAYLOAD",\n  "password": "x"\n}' }, explain: { why: 'The email field is concatenated into the auth query; a comment drops the password check.', fix: 'Parameterized queries and constant-time password verification.' } },
  'stored-xss-review': { category: 'Cross-site scripting', template: { method: 'POST', url: '/api/products/1/reviews', body: '{\n  "author": "attacker",\n  "body": "PAYLOAD"\n}' }, explain: { why: 'Review text is stored and later rendered verbatim to everyone viewing the product.', fix: 'Escape on output, sanitize HTML, and set a CSP.' } },
  'mass-assignment-register-admin': { category: 'Access control', template: { method: 'POST', url: '/api/register', body: '{\n  "email": "you@x.test",\n  "password": "p",\n  "PAYLOAD": "PAYLOAD"\n}' }, explain: { why: 'Registration binds every field it receives, including one that grants privileges.', fix: 'Allow-list bindable fields; never let clients set role/privilege attributes.' } },
  'mass-assignment-profile-admin': { category: 'Access control', template: { method: 'PUT', url: '/api/me', headers: 'Authorization: Bearer <your token>', body: '{\n  "PAYLOAD": "PAYLOAD"\n}' }, explain: { why: 'The profile update trusts whatever fields arrive, including privilege fields.', fix: 'Allow-list updatable fields server-side.' } },
  'path-traversal-download': { category: 'File handling', template: { method: 'GET', url: '/api/download?file=PAYLOAD' }, explain: { why: 'The filename is used to build a path with no sanitisation, so ../ escapes the intended folder.', fix: 'Resolve and confirm the path stays within an allowed base directory; use an id-to-file map.' } },
  'insecure-upload-active-content': { category: 'File handling', template: { method: 'POST', url: '/api/upload', body: '{\n  "filename": "PAYLOAD",\n  "content": "PAYLOAD"\n}' }, explain: { why: 'Arbitrary filenames/types are accepted and served back from the web root, so an uploaded .html/.svg runs.', fix: 'Validate type, store outside the web root, serve with safe content-types and a random name.' } },
  'order-by-injection': { category: 'SQL injection', template: { method: 'GET', url: '/api/catalog?sort=PAYLOAD' }, explain: { why: 'The sort parameter is concatenated into ORDER BY, which can\u2019t be parameterized directly.', fix: 'Map the sort key against an allow-list of column names.' } },
  'idor-invoice': { category: 'Access control', template: { method: 'GET', url: '/api/invoices/PAYLOAD' }, explain: { why: 'Invoices are fetched by id with no ownership check.', fix: 'Tie every invoice to its owner and verify on access.' } },
  'open-redirect': { category: 'Open redirect', template: { method: 'GET', url: '/api/go?url=PAYLOAD' }, explain: { why: 'The redirect target comes straight from a parameter with no allow-list.', fix: 'Only redirect to relative paths or a vetted allow-list of hosts.' } },
  'weak-password-reset': { category: 'Authentication', depends: ['idor-user-record'], template: { method: 'POST', url: '/api/reset/confirm', body: '{\n  "email": "dj.mole@vinylvault.test",\n  "answer": "PAYLOAD",\n  "new_password": "pwned"\n}' }, explain: { why: 'Reset relies on a security answer that is disclosed by the user-record IDOR — chain them.', fix: 'Use time-limited, random reset tokens sent out-of-band; never rely on guessable/leakable answers.' } },
  'jwt-weak-secret-forge': { category: 'JWT & sessions', depends: ['debug-config-exposed'], template: { method: 'GET', url: '/api/admin/ledger', headers: 'Authorization: Bearer <forge in Tools \u2192 JWT>' }, explain: { why: 'Tokens are HS256-signed with a weak, committed secret, so you can sign your own admin token.', fix: 'Use a long random secret from a secret store; rotate it; consider asymmetric keys.' } },
  'blind-sqli-user-enum': { category: 'SQL injection', template: { method: 'GET', url: '/api/check-email?email=PAYLOAD' }, explain: { why: 'A yes/no endpoint is injectable; boolean conditions leak data one bit at a time.', fix: 'Parameterize the query and return uniform responses.' } },
  'ssrf-cover-art': { category: 'SSRF', template: { method: 'POST', url: '/api/products/1/cover', body: '{\n  "url": "PAYLOAD"\n}' }, explain: { why: 'The server fetches a URL you supply, so you can point it at internal addresses.', fix: 'Allow-list schemes/hosts, resolve and block private/link-local ranges, disable redirects.' } },
  'prototype-pollution': { category: 'Prototype pollution', template: { method: 'POST', url: '/api/preferences', body: '{\n  "PAYLOAD": { "PAYLOAD": "PAYLOAD" }\n}' }, explain: { why: 'A recursive merge copies special keys like __proto__ onto the shared object prototype.', fix: 'Reject __proto__/constructor keys; use Map or Object.create(null); use a safe merge.' } },
  'coupon-stacking': { category: 'Business logic', template: { method: 'POST', url: '/api/checkout/apply-coupons', body: '{\n  "total": 10,\n  "codes": [ "PAYLOAD", "PAYLOAD" ]\n}' }, explain: { why: 'Multiple coupons are summed with no cap, so the discount can exceed the price.', fix: 'Enforce one coupon (or a max discount) and validate server-side.' } },
  'command-injection': { category: 'Injection', template: { method: 'GET', url: '/api/tools/ping?host=PAYLOAD' }, explain: { why: 'Input is passed to a shell without sanitisation, so metacharacters run extra commands.', fix: 'Avoid the shell; use execFile with an argument array and validate input.' } },
  'second-order-sqli': { category: 'SQL injection', template: { method: 'PUT', url: '/api/me', headers: 'Authorization: Bearer <your token>', body: '{\n  "display_name": "PAYLOAD"\n}' }, explain: { why: 'A stored value is later concatenated into a query, so the injection fires on a second request.', fix: 'Parameterize everywhere — including when re-using stored data.' } },
  'csv-formula-injection': { category: 'File handling', template: { method: 'POST', url: '/api/orders', headers: 'Authorization: Bearer <your token>', body: '{\n  "items": [ { "productId": 1, "qty": 1 } ],\n  "address": "PAYLOAD"\n}' }, explain: { why: 'Exported CSV cells aren\u2019t neutralised, so a value starting with = becomes a live formula in a spreadsheet.', fix: 'Prefix risky cells with a quote or sanitise leading = + - @ on export.' } },
  'insecure-deserialization-cookie': { category: 'Deserialization', template: { method: 'GET', url: '/api/preferences/whoami?prefs=PAYLOAD' }, explain: { why: 'The prefs blob is base64-decoded and trusted with no integrity check, so you can flip your role.', fix: 'Sign/verify client-held state (HMAC) or keep it server-side.' } },
  'jwt-alg-none': { category: 'JWT & sessions', template: { method: 'GET', url: '/api/admin/stats', headers: 'Authorization: Bearer <forge alg:none in Tools>' }, explain: { why: 'The verifier accepts a token whose header says alg:none, i.e. no signature at all.', fix: 'Pin the expected algorithm; reject "none".' } },
  'ssti': { category: 'Injection', template: { method: 'POST', url: '/api/orders/1/message', body: '{\n  "template": "PAYLOAD"\n}' }, explain: { why: 'Template placeholders are evaluated server-side, so {{expression}} executes.', fix: 'Never evaluate user input as a template; use a logic-less template engine with escaping.' } },
  'xxe': { category: 'Injection', template: { method: 'POST', url: '/api/import', body: '{\n  "xml": "PAYLOAD"\n}' }, explain: { why: 'The XML parser resolves DOCTYPE/entity declarations, allowing external entity references.', fix: 'Disable DTDs and external entities in the parser.' } },
  'sqli-union-users': { category: 'SQL injection', template: { method: 'GET', url: '/api/products/search?q=PAYLOAD' }, explain: { why: 'A UNION SELECT grafts rows from the users table onto the search results.', fix: 'Parameterized queries and least-privilege DB accounts.' } },
  'jwt-unverified-endpoint': { category: 'JWT & sessions', template: { method: 'GET', url: '/api/premium/lounge', headers: 'Authorization: Bearer <any token, bad signature>' }, explain: { why: 'This endpoint decodes the token but never verifies the signature.', fix: 'Always verify the signature and algorithm on every request.' } },
  'admin-flag-captured': { category: 'JWT & sessions', depends: ['mass-assignment-register-admin'], template: { method: 'GET', url: '/api/admin/vault', headers: 'Authorization: Bearer <a genuine admin token>' }, explain: { why: 'The vault requires a real database admin, so you must actually escalate (e.g. via mass assignment) first.', fix: 'Prevent privilege escalation at the source; enforce server-side role checks.' } },
  'host-header-injection': { category: 'Server misconfig', template: { method: 'POST', url: '/api/reset/link', headers: 'X-Forwarded-Host: PAYLOAD', body: '{\n  "email": "dj.mole@vinylvault.test"\n}' }, explain: { why: 'The reset link is built from a client-controlled host header.', fix: 'Build absolute URLs from a configured canonical host, not request headers.' } },
  'redos': { category: 'Server misconfig', template: { method: 'GET', url: '/api/validate/handle?h=PAYLOAD' }, explain: { why: 'A vulnerable regex backtracks catastrophically on crafted input, hanging the request.', fix: 'Use linear-time regex engines/patterns or input length limits.' } },
  'cors-credential-theft': { category: 'Server misconfig', template: { method: 'GET', url: '/api/account/secret', headers: 'X-Test-Origin: PAYLOAD' }, explain: { why: 'The server reflects any Origin and allows credentials, so a foreign site can read your data.', fix: 'Allow-list origins; never reflect arbitrary origins with credentials.' } },
  'jwt-kid-injection': { category: 'JWT & sessions', template: { method: 'GET', url: '/api/reports', headers: 'Authorization: Bearer <kid-injected token from Tools>' }, explain: { why: 'The token\u2019s kid header is used in a key-lookup query, which is injectable.', fix: 'Treat kid as an opaque id looked up safely; parameterize/allow-list it.' } },
};

for (const c of CHALLENGES) {
  const e = EXTRA[c.id] || {};
  c.category = e.category || 'Misc';
  c.starter = !!e.starter;
  c.depends = e.depends || [];
  c.template = e.template || null;
  c.explain = e.explain || null;
}

module.exports = CHALLENGES;
module.exports.POINTS = POINTS;
module.exports.FIRST_BLOOD = FIRST_BLOOD;
module.exports.TIER_ORDER = TIER_ORDER;
module.exports.CATEGORY_PRIMERS = CATEGORY_PRIMERS;
