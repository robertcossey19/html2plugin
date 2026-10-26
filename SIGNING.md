# Real Apple signing (Developer ID + notarization)

Without this, every build is ad-hoc signed and macOS makes you right-click → Open the .pkg once.
With it, the pipeline signs with your Developer ID, notarizes with Apple, staples the ticket, and
refuses to publish a release that Gatekeeper would reject (`spctl -a -t install` must pass).

Only you can do the Apple side: certificates are tied to your Apple ID and team. It takes about
30 minutes the first time and never again.

## 1. Apple Developer Program

[developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) — $99/year, individual is fine.
Note your 10-character **Team ID** (Membership details).

## 2. Two certificates (on any Mac)

Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority → save to disk.
Then at [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list) create, using that request:

- **Developer ID Application** (signs the .vst3 / .component / .app)
- **Developer ID Installer** (signs the .pkg files)

Download both `.cer`, double-click to install them in the login keychain.

## 3. Export as .p12

Keychain Access → My Certificates → select **both** Developer ID certificates (each shows a private key
underneath; if a key is missing you made the request on a different Mac) → right-click → Export 2 items →
`.p12`, pick a password. Then:

```
base64 -i Certificates.p12 | pbcopy
```

## 4. Notarization key

[App Store Connect → Users and Access → Integrations → Team Keys](https://appstoreconnect.apple.com/access/integrations/api)
→ Generate API key, role **Developer**. Note the **Key ID** and **Issuer ID**, download `AuthKey_XXXX.p8` (one-time download).

```
base64 -i AuthKey_XXXX.p8 | pbcopy
```

(Alternative: `APPLE_ID` + `APPLE_APP_PASSWORD` (an app-specific password from appleid.apple.com) + `APPLE_TEAM_ID`. Works, slower to set up on the Apple side.)

## 5. Repo secrets

GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:

| secret | value |
|---|---|
| `APPLE_CERT_P12_BASE64` | base64 of the .p12 (both certs) |
| `APPLE_CERT_PASSWORD` | the .p12 password |
| `APPLE_TEAM_ID` | 10-character team ID |
| `APPLE_NOTARY_KEY_P8_BASE64` | base64 of AuthKey_XXXX.p8 |
| `APPLE_NOTARY_KEY_ID` | key ID |
| `APPLE_NOTARY_ISSUER_ID` | issuer ID (UUID) |

Optional: `APPLE_INSTALLER_P12_BASE64` if you exported the Installer certificate as a separate .p12 (same password).

Or from a terminal with `gh` logged in:

```
gh secret set APPLE_CERT_P12_BASE64 -R robertcossey19/html2plugin < <(base64 -i Certificates.p12)
gh secret set APPLE_CERT_PASSWORD -R robertcossey19/html2plugin
gh secret set APPLE_TEAM_ID -R robertcossey19/html2plugin
gh secret set APPLE_NOTARY_KEY_P8_BASE64 -R robertcossey19/html2plugin < <(base64 -i AuthKey_XXXX.p8)
gh secret set APPLE_NOTARY_KEY_ID -R robertcossey19/html2plugin
gh secret set APPLE_NOTARY_ISSUER_ID -R robertcossey19/html2plugin
```

## 6. What the pipeline then does, per build

1. Imports the certificates into a throwaway keychain; auto-detects the two identities.
2. Builds with hardened runtime + entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `audio-input`).
3. `codesign --options runtime --timestamp` on .vst3 / .component / .app, then `notarytool submit --wait`, `stapler staple`, `stapler validate` on each bundle.
4. `pkgbuild --sign` / `productbuild --sign` with the Installer identity, `notarytool submit --wait`, `stapler staple`, then `spctl -a -t install` — the build fails if Gatekeeper would not accept the .pkg.
5. Release notes say `Developer ID + notarized + stapled`; `testlogs/gatekeeper.txt` carries the spctl output.

Expect notarization to add 3–10 minutes per build (five submissions). If Apple rejects, the run fails with the notary log in the job output; nothing unsigned is published under a "signed" label.
