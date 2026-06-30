# Identra App Auth Flow

This document describes how `identra-app` integrates with the Auth API exposed by
`identra-server`. The production readiness checklist is maintained separately in
`docs/auth-production-readiness.md`.

Local base URL:

```text
http://localhost:4000/v1
```

## Principles

- Authentication uses phone number and password.
- OTP is used only for registration verification and login step-up on unknown devices.
- Known-device login uses phone number and password, without OTP.
- After successful registration OTP verification, the app must ask the user to set a password.
- Passwords are hashed server-side with Argon2id and a pepper. The database never stores plaintext passwords.
- The current OTP provider is demo-only and always uses `000000`, but OTP codes are still stored as HMAC hashes.
- Access tokens are short-lived JWTs.
- Refresh tokens are opaque long-lived tokens. The database stores only HMAC hashes.
- Refresh tokens are rotated on every refresh.
- Biometrics are local app lock or local secure-storage unlock only. They do not replace server authentication.
- Full logout revokes the server-side session and clears local tokens. A later login uses the password; if the device is still trusted, OTP is not required.
- Revoking a device removes device trust. The next login from that device requires password first, then OTP.

## Device Identity

The app must create and keep a stable `deviceId` for each app installation.

```json
{
  "deviceId": "ios-installation-7b7f0e2c9a",
  "platform": "ios",
  "deviceName": "iPhone 15 Pro",
  "appVersion": "1.0.0"
}
```

Recommendations:

- Generate `deviceId` on first app launch.
- Store `deviceId` in Secure Storage, Keychain, or Keystore.
- Do not rotate `deviceId` on every app launch.
- If the user deletes the app or clears secure storage, the next installation is treated as a new device.

## Password Policy

The MVP server currently validates:

```text
min length: PASSWORD_MIN_LENGTH, default 8
max length: PASSWORD_MAX_LENGTH, default 128
must not start or end with whitespace
must contain only printable ASCII characters, U+0020 through U+007E
```

The app should display at least:

```text
Password must be 8 to 128 characters.
Password must not start or end with whitespace.
Use only ASCII letters, digits, and ASCII special characters.
Vietnamese accents, emoji, and other Unicode characters are not allowed.
```

Do not trim passwords before sending them to the server. If the user enters leading
or trailing whitespace, the server rejects the password so the user can correct it.

Demo seed password:

```text
IdentraDemo123
```

## App Token Storage

After registration completion or successful login, the app receives:

- `accessToken`: store in memory or short-lived secure storage.
- `refreshToken`: store only in Keychain, Keystore, or equivalent secure storage. Do not store it in AsyncStorage or plaintext storage.
- `deviceId`: store in Keychain, Keystore, or equivalent secure storage.

When biometric app lock is enabled:

```text
Open app -> local biometric prompt -> unlock refreshToken -> call /auth/token/refresh
```

When the user chooses "Log out":

```text
Call /auth/logout -> clear local accessToken and refreshToken -> return to login
```

## Registration Flow

### 1. Start Registration

```http
POST /v1/auth/register/start
Content-Type: application/json
```

Request:

```json
{
  "phone": "0382948210",
  "device": {
    "deviceId": "ios-installation-7b7f0e2c9a",
    "platform": "ios",
    "deviceName": "iPhone 15 Pro",
    "appVersion": "1.0.0"
  }
}
```

Response:

```json
{
  "data": {
    "challengeId": "cm...",
    "purpose": "register",
    "phone": "+84382948210",
    "expiresAt": "2026-06-30T08:05:00.000Z",
    "resendAvailableAt": "2026-06-30T08:01:00.000Z",
    "maxAttempts": 5,
    "delivery": {
      "channel": "sms",
      "provider": "demo",
      "to": "+84382948210",
      "demoOtp": "000000"
    }
  }
}
```

### 2. Verify Registration OTP

```http
POST /v1/auth/register/verify
Content-Type: application/json
```

Request:

```json
{
  "challengeId": "cm...",
  "phone": "0382948210",
  "otpCode": "000000",
  "fullName": "Nguyen Van An",
  "device": {
    "deviceId": "ios-installation-7b7f0e2c9a",
    "platform": "ios",
    "deviceName": "iPhone 15 Pro",
    "appVersion": "1.0.0"
  }
}
```

Response:

```json
{
  "data": {
    "user": {
      "id": "cm...",
      "phone": "+84382948210",
      "phoneVerifiedAt": "2026-06-30T08:00:00.000Z",
      "fullName": "Nguyen Van An"
    },
    "registration": {
      "registrationToken": "...",
      "registrationTokenExpiresAt": "2026-06-30T08:15:00.000Z",
      "nextAction": "SET_PASSWORD"
    }
  }
}
```

The app does not receive access or refresh tokens at this step. It must move to
the password setup screen.

### 3. Set Registration Password

```http
POST /v1/auth/register/password
Content-Type: application/json
```

Request:

```json
{
  "registrationToken": "...",
  "password": "IdentraDemo123",
  "device": {
    "deviceId": "ios-installation-7b7f0e2c9a",
    "platform": "ios",
    "deviceName": "iPhone 15 Pro",
    "appVersion": "1.0.0"
  }
}
```

Response:

```json
{
  "data": {
    "user": {
      "id": "cm...",
      "phone": "+84382948210",
      "phoneVerifiedAt": "2026-06-30T08:00:00.000Z",
      "fullName": "Nguyen Van An"
    },
    "session": {
      "id": "cm...",
      "deviceId": "ios-installation-7b7f0e2c9a",
      "platform": "ios",
      "deviceName": "iPhone 15 Pro",
      "appVersion": "1.0.0",
      "trustedAt": "2026-06-30T08:02:00.000Z",
      "trustRevokedAt": null,
      "lastSeenAt": "2026-06-30T08:02:00.000Z",
      "expiresAt": "2026-07-30T08:02:00.000Z",
      "revokedAt": null
    },
    "tokens": {
      "tokenType": "Bearer",
      "accessToken": "...",
      "accessTokenExpiresAt": "2026-06-30T08:17:00.000Z",
      "expiresInSeconds": 900,
      "refreshToken": "...",
      "refreshTokenExpiresAt": "2026-07-30T08:02:00.000Z"
    }
  }
}
```

After this response, the app stores `refreshToken` in secure storage.

## Login Flow

### 1. Start Login With Password

```http
POST /v1/auth/login/start
Content-Type: application/json
```

Request:

```json
{
  "phone": "0382948210",
  "password": "IdentraDemo123",
  "device": {
    "deviceId": "ios-installation-7b7f0e2c9a",
    "platform": "ios",
    "deviceName": "iPhone 15 Pro",
    "appVersion": "1.0.0"
  }
}
```

If the device is trusted, the response returns tokens immediately:

```json
{
  "data": {
    "user": {
      "id": "cm...",
      "phone": "+84382948210",
      "phoneVerifiedAt": "2026-06-30T08:00:00.000Z",
      "fullName": "Nguyen Van An"
    },
    "session": {
      "id": "cm...",
      "deviceId": "ios-installation-7b7f0e2c9a",
      "platform": "ios",
      "deviceName": "iPhone 15 Pro",
      "appVersion": "1.0.0",
      "trustedAt": "2026-06-30T08:02:00.000Z",
      "trustRevokedAt": null,
      "lastSeenAt": "2026-06-30T09:00:00.000Z",
      "expiresAt": "2026-07-30T09:00:00.000Z",
      "revokedAt": null
    },
    "tokens": {
      "tokenType": "Bearer",
      "accessToken": "...",
      "accessTokenExpiresAt": "2026-06-30T09:15:00.000Z",
      "expiresInSeconds": 900,
      "refreshToken": "...",
      "refreshTokenExpiresAt": "2026-07-30T09:00:00.000Z"
    }
  }
}
```

If the password is valid but the device is unknown, the response asks for OTP:

```json
{
  "data": {
    "challengeId": "cm...",
    "purpose": "login",
    "phone": "+84382948210",
    "expiresAt": "2026-06-30T09:05:00.000Z",
    "resendAvailableAt": "2026-06-30T09:01:00.000Z",
    "maxAttempts": 5,
    "delivery": {
      "channel": "sms",
      "provider": "demo",
      "to": "+84382948210",
      "demoOtp": "000000"
    },
    "deviceKnown": false,
    "requiresOtp": true
  }
}
```

### 2. Verify Login OTP For Unknown Device

Call this endpoint only when `/auth/login/start` returns `requiresOtp: true`.

```http
POST /v1/auth/login/verify
Content-Type: application/json
```

Request:

```json
{
  "challengeId": "cm...",
  "phone": "0382948210",
  "otpCode": "000000",
  "device": {
    "deviceId": "android-installation-9021",
    "platform": "android",
    "deviceName": "Pixel 9",
    "appVersion": "1.0.0"
  }
}
```

The response returns `user`, `session`, and `tokens` like a successful login. After
this step, the device is marked as trusted.

## Opening The App On A Trusted Device

The app should not call `/auth/login/start` if it still has a valid refresh token.

Correct flow:

```text
1. The app opens.
2. If a local refreshToken exists:
   - show a biometric prompt if the user enabled app lock.
   - unlock the refreshToken after biometric success.
3. The app calls /v1/auth/token/refresh.
4. The server rotates the refresh token and returns a new access token.
5. The app replaces the old refreshToken with the new one.
```

Request:

```http
POST /v1/auth/token/refresh
Content-Type: application/json
```

```json
{
  "refreshToken": "...",
  "deviceId": "ios-installation-7b7f0e2c9a"
}
```

If the refresh token is invalid, expired, or revoked, the app must clear local
tokens and send the user to password login. If the device is still trusted, the
password login does not require OTP.

## Logout And Device Revocation

### Logout Current Device

```http
POST /v1/auth/logout
Authorization: Bearer <accessToken>
Content-Type: application/json
```

The request body may also include the refresh token:

```json
{
  "refreshToken": "..."
}
```

After logout:

- The server revokes the session and refresh token.
- The app clears local access and refresh tokens.
- The device may remain trusted for later password login.
- Biometric login is not available after logout.

### Logout All Devices

```http
POST /v1/auth/logout-all
Authorization: Bearer <accessToken>
```

Logout-all revokes sessions, but does not necessarily remove device trust. To
remove trust, revoke the device.

### List Devices

```http
GET /v1/auth/devices
Authorization: Bearer <accessToken>
```

### Revoke Device

```http
DELETE /v1/auth/devices/:id
Authorization: Bearer <accessToken>
```

Device revocation sets `trustRevokedAt`. The next password login from that device
is treated as an unknown-device login and requires OTP.

## Error Codes The App Should Handle

Registration:

```text
PHONE_ALREADY_REGISTERED
REGISTRATION_TOKEN_INVALID
PASSWORD_ALREADY_SET
PASSWORD_LENGTH_INVALID
PASSWORD_EDGE_WHITESPACE
PASSWORD_UNSUPPORTED_CHARACTER
```

Login and password:

```text
PHONE_NOT_REGISTERED
PASSWORD_NOT_SET
PASSWORD_INVALID
PASSWORD_LOCKED
```

OTP:

```text
OTP_RATE_LIMITED
OTP_RESEND_COOLDOWN
OTP_CHALLENGE_NOT_FOUND
OTP_ALREADY_CONSUMED
OTP_EXPIRED
OTP_ATTEMPTS_EXCEEDED
OTP_INVALID
```

Token and session:

```text
ACCESS_TOKEN_REQUIRED
ACCESS_TOKEN_INVALID
SESSION_REVOKED_OR_EXPIRED
INVALID_REFRESH_TOKEN
REFRESH_TOKEN_DEVICE_MISMATCH
LOGOUT_TOKEN_REQUIRED
DEVICE_SESSION_NOT_FOUND
CANNOT_REVOKE_CURRENT_DEVICE_HERE
```

## Related Server Configuration

```text
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_DAYS=30
AUTH_REGISTRATION_TOKEN_TTL_SECONDS=900
PASSWORD_MIN_LENGTH=8
PASSWORD_MAX_LENGTH=128
PASSWORD_MAX_FAILED_ATTEMPTS=5
PASSWORD_LOCK_SECONDS=900
OTP_DEMO_CODE=000000
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60
OTP_MAX_STARTS_PER_HOUR=5
```

Production must replace the demo OTP provider with a real SMS provider and must
not return `delivery.demoOtp`.
