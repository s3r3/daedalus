# macOS Development & Distribution

Guides for building and signing the Presenton Electron app on macOS.

| Guide | Description |
|-------|-------------|
| [Direct distribution](./direct-distribution.md) | Developer ID signing, notarization, DMG verification, and release commands for distribution outside the Mac App Store |
| [Mac App Store setup](./mac-app-store-setup.md) | Certificates, provisioning profiles, MAS build commands, and submission notes |

## Quick reference

All commands below run from the `electron/` directory on a Mac.

**First-time setup**

```bash
cd electron
npm run setup:env
```

**Run locally (development)**

```bash
npm run dev
```

**Build a DMG (local distribution, not App Store)**

```bash
npm run build:all
```

Output is written to `electron/dist/`. The default macOS target is a DMG built via `electron/build.js`.

For public releases outside the Mac App Store, use the signed and notarized direct distribution flow:

```bash
export APPLE_KEYCHAIN_PROFILE="presenton-notary"
npm run build:all:mac:signed
```

That assumes the release Mac already has a **Developer ID Application** certificate and a stored `notarytool` profile named `presenton-notary`. See [Direct distribution](./direct-distribution.md) for the exact one-time setup and verification commands.

**Build for the Mac App Store**

See [Mac App Store setup](./mac-app-store-setup.md) for certificates, provisioning profiles, and signing. Summary:

```bash
npm run build:all:mas-dev   # development / TestFlight-style testing
npm run build:all:mas       # distribution / App Store submission
```

## Related docs

- [Electron dependency strategy](../../electron-dependency-strategy.md) — bundled Chromium, ImageMagick, and export runtime
- [Project README — Electron section](../../../README.md) — prerequisites and high-level build steps
