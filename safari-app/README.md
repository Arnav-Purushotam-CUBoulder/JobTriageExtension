# Safari Wrapper Project

This folder contains a generated Safari wrapper app project for the extension:

- `JobTriageSafari.xcodeproj`
- app target: `JobTriageSafari`
- extension target: `JobTriageSafariExtension`

## Sync extension resources

When you update root extension files (`manifest.json`, `content.js`, `worker.js`, `icon1.png`), run:

```bash
./safari-app/sync-extension-files.sh
```

## Open in Xcode

```bash
open safari-app/JobTriageSafari.xcodeproj
```

Then in Xcode:

1. Set your Signing Team for both targets.
2. Build and run the `JobTriageSafari` macOS app target.
3. Enable the extension in Safari: `Settings > Extensions`.
