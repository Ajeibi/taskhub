# ADR 0002: Authentication

Status: accepted

## Design
- **Access token:** JWT (HS256), 15 min, claims `sub` + `role`. Verified without a DB hit, so any pod can serve any request. The algorithm is pinned on verify (blocks `alg=none` and key-confusion attacks).
- **Refresh token:** 32 random bytes, only its SHA-256 stored. 7-day expiry. Delivered as an `HttpOnly; SameSite=Strict; Path=/api/auth` cookie, so scripts (XSS) cannot read it and cross-site requests never carry it (no CSRF on refresh).
- **Rotation + reuse detection:** every refresh token is single-use and belongs to a *family* (one per login). Presenting an already-used token revokes the whole family. `SELECT ... FOR UPDATE` serialises concurrent refreshes so exactly one wins.
- **Passwords:** scrypt (N=2^15, r=8, p=1) from Node's standard library; per-password salt; self-describing hash format so cost can be raised later; constant-time compare. Min 10 / max 128 characters (length over composition rules; the cap bounds hashing cost).
- **Login hardening:** identical error for unknown email and wrong password, and a dummy hash is verified for unknown emails so response time does not reveal which accounts exist. Per-IP rate limit on login/register.
- **Registration race safety:** duplicate emails are caught from the unique index (`23505` -> 409), not check-then-insert.
- **Roles:** new accounts are always `user`. `admin` can only be granted directly in the database (seed/ops), never through the API.

## Why not the alternatives
- **bcrypt/argon2 packages:** native add-ons complicate container builds; scrypt is memory-hard and built in. Argon2id is marginally preferred by OWASP; swapping is isolated to `password.ts` thanks to the versioned hash format.
- **Server sessions:** instantly revocable but require a shared session store across pods.
- **Access token in a cookie / localStorage:** the SPA keeps it in memory only, so it is not persisted where XSS could steal a long-lived credential.

## Known trade-offs (be ready to discuss)
- A stateless access token stays valid until it expires (max 15 min) even if the user is deleted or demoted. Mitigation: short TTL; for instant revocation add a token-version check.
- The in-memory rate limiter is per pod. With N replicas the effective limit is N times higher. Production answer: ingress rate limiting or a Redis store.
- Registration reveals whether an email is taken (409). Accepted for usability; login does not.
- Strict reuse detection means a client that fires two refreshes at once (e.g. two tabs) can be logged out. The SPA must serialise refresh calls.
- Expired/revoked refresh-token rows accumulate; a periodic cleanup job is needed at scale.
