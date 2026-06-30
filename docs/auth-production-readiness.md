# Auth Production Readiness

This document is the production checklist for Identra Auth. It complements
`docs/auth-flow.md`, which describes the API contract used by `identra-app`.

## Current State

The Auth MVP currently includes:

- Registration with phone number and OTP.
- Password setup after successful OTP verification.
- Login with phone number and password.
- Trusted-device login without OTP.
- Unknown-device login that requires password first, then OTP step-up.
- Server-side password hashing with Argon2id and a pepper.
- No plaintext password storage.
- Demo OTP value `000000`, while stored OTP values are HMAC hashes.
- Short-lived JWT access tokens.
- Opaque refresh tokens, with only HMAC hashes stored in the database.
- Refresh token rotation on `/auth/token/refresh`.
- Logout that revokes sessions and tokens, but does not automatically remove device trust.
- Device revocation that removes device trust.
- Biometrics treated only as local app lock or local secure-storage unlock, not server authentication.

Existing endpoints:

```text
POST   /v1/auth/register/start
POST   /v1/auth/register/verify
POST   /v1/auth/register/password
POST   /v1/auth/login/start
POST   /v1/auth/login/verify
POST   /v1/auth/token/refresh
POST   /v1/auth/logout
POST   /v1/auth/logout-all
GET    /v1/auth/devices
DELETE /v1/auth/devices/:id
```

## Do Not Ship To Production Until These Are Done

Before production, at minimum:

- Replace demo OTP `000000` with a real SMS or OTP provider.
- Stop returning `delivery.demoOtp` in responses.
- Replace all development secrets in `.env`.
- Add Redis-backed rate limiting for OTP, password login, and refresh tokens.
- Add an anti-enumeration policy for phone lookup.
- Add audit logs for sensitive auth events.
- Add refresh token reuse detection.
- Add password reset and password change flows.
- Add breached/common password checks.
- Add cleanup jobs for expired OTP challenges and registration tokens.
- Add e2e tests for registration, password setup, known-device login, unknown-device login, refresh, and logout.
- Define an operational process to revoke all sessions when risk is detected.

## P0 - Required Before Production

### 1. Real SMS/OTP Provider

The server currently uses `OTP_DEMO_CODE=000000`. Production needs a real provider.

Implement:

- `OtpProvider` interface.
- SMS vendor adapter.
- Bounded retry policy.
- Delivery-state logging without logging OTP codes.
- Localized message templates.
- Rejection for invalid, unsupported, or disallowed phone numbers.

Production responses must not include:

```json
{
  "demoOtp": "000000"
}
```

### 2. Distributed Rate Limiting

The current database-backed phone/purpose limit is not enough for production.

Add Redis-backed rate limits for:

```text
auth_register_start_by_phone
auth_register_start_by_ip
auth_register_start_by_device
auth_register_password_by_registration_token
auth_login_password_by_phone
auth_login_password_by_ip
auth_login_password_by_device
auth_otp_verify_by_challenge
auth_otp_verify_by_phone
auth_otp_verify_by_ip
auth_refresh_by_token_hash
auth_refresh_by_device
```

Suggested initial policy:

```text
register/start:
  phone: 5/hour
  ip: 30/hour
  device: 10/hour

login/start:
  phone: 10/hour
  ip: 60/hour
  device: 30/hour

otp verify:
  challenge: 5 attempts total
  phone: 20/hour
  ip: 60/hour

refresh:
  device: 120/hour
```

### 3. Production Password Policy

Already implemented:

```text
min length
max length
reject leading/trailing whitespace
reject Unicode and non-printable ASCII
Argon2id hash
pepper
failed-attempt lock
```

Add before production:

- Common-password and breached-password checks.
- No rigid composition rules unless required by compliance.
- No password logging.
- No server-side password trimming.
- Password change flow for authenticated users.
- Password reset or recovery flow with step-up verification.
- Secret rotation plan for `PASSWORD_PEPPER`.

Recommended defaults:

```text
PASSWORD_MIN_LENGTH=8 or 12 depending on UX
PASSWORD_MAX_LENGTH=128
PASSWORD_MAX_FAILED_ATTEMPTS=5
PASSWORD_LOCK_SECONDS=900
```

### 4. Anti-Enumeration Policy

The current API may return explicit codes:

```text
PHONE_ALREADY_REGISTERED
PHONE_NOT_REGISTERED
PASSWORD_NOT_SET
```

This is useful for MVP and app development, but it can leak account existence.

Choose a production policy:

```text
Mode A - clearer UX:
  keep explicit codes
  require strong rate limiting
  monitor phone enumeration patterns

Mode B - stronger privacy:
  use generic responses
  show neutral app messages
  reveal account state only after OTP or in a trusted context
```

Recommendation:

- Closed beta: Mode A is acceptable with strong rate limiting.
- Public production: gradually move toward Mode B.

### 5. Refresh Token Reuse Detection

Refresh tokens are currently rotated, but old token history is not stored.

Add:

```text
RefreshTokenRotation
  id
  sessionId
  tokenHash
  replacedByHash
  usedAt
  revokedAt
  createdAt
```

When an old token is reused:

- Revoke the current session.
- Revoke all user sessions if risk is high.
- Write audit event `refresh_token_reuse_detected`.
- Require password login plus OTP if the device is considered unsafe.
- Send a security notification.

### 6. Auth Audit Logs

Log these events:

```text
auth.register_start
auth.register_otp_verify_success
auth.register_otp_verify_failed
auth.register_password_set
auth.login_password_success
auth.login_password_failed
auth.login_otp_required
auth.login_otp_verify_success
auth.login_otp_verify_failed
auth.refresh_success
auth.refresh_failed
auth.refresh_token_reuse_detected
auth.logout
auth.logout_all
auth.device_revoked
auth.rate_limited
auth.suspicious_phone_enumeration
```

Each event should include:

```text
userId nullable
phoneHash
deviceId
ipAddress
userAgent
eventType
status
riskLevel
metadata
createdAt
```

Never store:

```text
plaintext password
plaintext OTP
plaintext access token
plaintext refresh token
plaintext registration token
```

### 7. Production Secrets And Environment

Do not use default development secrets:

```text
JWT_ACCESS_SECRET=dev_access_secret_change_me
JWT_REFRESH_SECRET=dev_refresh_secret_change_me
AUTH_REGISTRATION_TOKEN_SECRET=dev_registration_secret_change_me
PASSWORD_PEPPER=dev_password_pepper_change_me
OTP_HMAC_SECRET=dev_otp_secret_change_me
```

Production needs:

- Random high-entropy secrets, at least 32 bytes of entropy.
- Secret manager storage, never committed to the repository.
- Separate secrets for development, staging, and production.
- Secret rotation plan.
- Versioning for peppers and signing secrets.

### 8. Standard Phone Validation

Phone normalization is currently custom and Vietnam-first.

Replace it with a standard library such as `libphonenumber-js`:

- Parse with default country `VN`.
- Validate mobile numbers.
- Store phone numbers in E.164.
- Reject invalid, premium-rate, or unsupported regions when needed.

### 9. Cleanup Jobs

Add cleanup jobs for:

```text
OtpChallenge:
  consumedAt != null and older than 7 days
  expiresAt older than 7 days
  passwordSetupExpiresAt older than 7 days

DeviceSession:
  revokedAt older than the retention window
```

If records are retained for forensics, redact sensitive fields.

### 10. E2E Tests

Minimum required tests:

```text
register/start success
register/start existing phone with password
register/verify success returns registration token
register/password success returns tokens
register/password invalid token
register/password weak password
login/start known device with valid password returns tokens
login/start unknown device with valid password returns OTP challenge
login/start invalid password increments failed attempts
login/start locked password
login/verify unknown device success returns tokens
login/verify wrong OTP
login/verify expired OTP
refresh success and rotation
refresh with old token fails
refresh device mismatch revokes session
logout revokes current session
logout keeps device trust
revoke device removes trust
rate limit exceeded
unknown fields rejected by ValidationPipe
```

## P1 - Add Soon After MVP

### 1. Device-Bound Biometric Challenge

Biometrics currently only unlock local refresh-token storage. The server does not
know that the user completed a biometric check.

Proposed upgrade:

```text
1. After successful login, the app creates a key pair in Secure Enclave, Keychain, or Android Keystore.
2. The private key is protected by biometric or user presence.
3. The app sends the public key to the server.
4. The server binds the public key to the device.
5. When step-up is required, the server sends a challenge.
6. The app asks for biometric confirmation and signs the challenge with the private key.
7. The server verifies the signature and grants a high-assurance session.
```

Possible APIs:

```text
POST /v1/auth/device-credentials/register
POST /v1/auth/device-credentials/challenge
POST /v1/auth/device-credentials/verify
```

### 2. Risk-Based Step-Up

Add a risk engine for:

```text
new_device
new_ip_country
impossible_travel
many_failed_password
many_failed_otp
refresh_token_mismatch
rooted_or_jailbroken_signal
old_app_version
```

When risk is high:

- Require OTP again.
- Require a biometric-signed challenge.
- Revoke the session.
- Send a security notification.

### 3. Shared Auth Guards For REST And GraphQL

Auth endpoints currently verify access tokens inside the service.

Add:

```text
JwtAuthGuard
CurrentUser decorator
CurrentSession decorator
Scopes decorator
HighAssuranceGuard
```

GraphQL context should also read real JWTs instead of demo headers such as
`x-identra-user-id`.

### 4. Better Session And Device Management

Add:

```text
deviceModel
osVersion
pushTokenHash
lastIpCountry
lastCity nullable
lastRiskLevel
revokedReason
revokedBy
trustRevokedReason
```

### 5. Security Notifications

Send notifications for:

```text
login from new device
password changed
password reset
logout-all
device revoked
refresh token reuse detected
phone changed
high-risk activity
```

## P2 - Longer-Term Improvements

### 1. Passkeys And WebAuthn

Passwords are part of the MVP. Long term, consider passkeys, WebAuthn, or
device-bound credentials to reduce dependence on password plus SMS OTP.

### 2. Admin And Support Recovery

Define support processes for:

- Lost device.
- Forgotten password.
- Phone number change.
- SIM takeover.
- User-requested all-device revocation.

Recovery should not rely only on SMS OTP. For Identra, combine:

- Existing trusted device.
- Identity credential.
- Support review.
- Cooldown period.
- Complete audit trail.

### 3. Data Retention

Define retention policy:

```text
OtpChallenge: 7-30 days or early redaction
DeviceSession revoked: 90-180 days
AuthAuditLog: 1-2 years depending on compliance
Rate limit counters: short TTL matching each window
```

### 4. Monitoring And Alerts

Create dashboards for:

```text
OTP requests/minute
OTP verify failures/minute
password failures/minute
password locked accounts
login success/failure
refresh failures
refresh token reuse detected
new device logins
logout-all spikes
SMS provider failure rate
```

Alert on:

- OTP failure spikes.
- Password failure spikes.
- SMS provider failure spikes.
- Phone enumeration patterns.
- Any refresh token reuse.
- Many logins from unusual IPs or ASNs.

## Migration Checklist

Before deploying real Auth:

```text
1. Create Prisma migration for OtpChallenge, UserPassword, and DeviceSession changes.
2. Backfill User.phone to E.164.
3. Set phoneVerifiedAt for appropriate demo/dev users.
4. Create password hashes for demo/dev users when needed.
5. Ensure unique phone constraints do not conflict after normalization.
6. Rotate all development secrets.
7. Run prisma migrate deploy in staging.
8. Run auth e2e tests in staging.
9. Verify the app stores tokens in secure storage.
10. Verify the app never stores passwords.
11. Verify logout clears local tokens.
12. Verify old refresh tokens cannot be used after rotation.
```

## Suggested Production Defaults

```text
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_DAYS=30
AUTH_REGISTRATION_TOKEN_TTL_SECONDS=900
PASSWORD_MIN_LENGTH=8
PASSWORD_MAX_LENGTH=128
PASSWORD_MAX_FAILED_ATTEMPTS=5
PASSWORD_LOCK_SECONDS=900
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60
OTP_MAX_STARTS_PER_HOUR=5
```

## Security Review Questions

Before every Auth release, answer:

- Can users be enumerated by phone number?
- Are passwords hashed with Argon2id?
- Are passwords logged anywhere?
- Are common or breached passwords blocked?
- Can OTP be brute-forced?
- Can OTP resend be abused?
- Can old refresh tokens be reused?
- Does logout really revoke server-side session state?
- Does device revocation remove device trust?
- Are biometrics clearly treated as local app lock rather than server auth?
- Does the app store refresh tokens only in secure storage?
- Does the app ever store passwords?
- Is every sensitive action audited?
- Are alerts configured for attack patterns?

## References

- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- NIST SP 800-63B: https://pages.nist.gov/800-63-4/sp800-63b.html
