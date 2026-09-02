# Tauri release signing

Tauri updater artifacts are authoritative for desktop releases. Release-only
settings live in `src-tauri/tauri.release.conf.json`; ordinary local builds do
not require private signing keys. CI workflow
`.github/workflows/tauri.yml` builds macOS arm64 DMG and Windows x64 NSIS
artifacts, validates updater metadata, and uploads bundle outputs.

Required repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_SIGNING_PUBLIC_KEY`

macOS signed runner additionally needs an Apple Developer certificate and
notarization credentials (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).
Import the certificate into the runner keychain before invoking
`package:tauri:mac`.

Windows signed runner needs a code-signing certificate installed in the
machine certificate store and configured for the Tauri Windows bundle. The
updater key secrets above sign the `.nsis.zip` update payload independently of
installer Authenticode signing.

Release verification:

1. Build with `pnpm --dir apps/desktop run package:tauri:mac` or
   `package:tauri:win`.
2. Confirm installer, updater payload, `.sig`, and `latest.json` exist under
   `src-tauri/target/<target>/release/bundle/`.
3. Validate artifacts with `collectTauriArtifacts` through
   `node --test scripts/publish_release.test.js` fixtures.
4. Install, launch, restart, uninstall, reinstall, then exercise updater
   download/install/relaunch on each signed runner.

Local builds without signing secrets can use `cargo build` and renderer tests;
release bundling intentionally fails closed when updater signing keys are
missing.
