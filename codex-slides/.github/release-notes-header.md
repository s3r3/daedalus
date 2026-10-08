## Download

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Codex-Slides-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Codex-Slides-<version>-mac-x64.dmg` |
| Windows | `Codex-Slides-<version>-windows-x64-Setup.exe` |
| Linux | `Codex-Slides-<version>-linux-x86_64.AppImage` / `.deb` |

> **macOS**: builds are not yet notarized with an Apple Developer ID. On first
> launch, right-click the app in Applications and choose **Open**, or allow it
> under **System Settings → Privacy & Security → Open Anyway**. If macOS
> reports the app as damaged, clear the quarantine flag once:
> `xattr -cr "/Applications/Codex Slides.app"`.
>
> **Windows**: if SmartScreen appears, choose **More info → Run anyway**.

`SHA256SUMS.txt` contains checksums for every asset. Verify with
`shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS/Linux).

## Changes

