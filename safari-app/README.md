# Safari Wrapper Project

This folder contains a generated Safari wrapper app project for the extension:

- `JobTriageSafari.xcodeproj`
- app target: `JobTriageSafari`
- extension target: `JobTriageSafariExtension`

## Sync extension resources

When you update root extension files (`manifest.json`, `content.js`, `worker.js`, `icon1.png`, `.env`), run:

```bash
./safari-app/sync-extension-files.sh
```

## Build + Install (cleans old versions first)

Run this command from the repository root:

```bash
./safari-app/build-install-safari.sh
```

It does all of the following in order:
- syncs extension resources
- builds `JobTriageSafari`
- removes older installed copies / stale registered extension entries
- installs the newest app copy
- launches the installed app

## API key source

Set the OpenAI key only in the root `.env` file:

```bash
OPENAI_API_KEY=sk-...
```

The sync/build scripts copy `.env` into extension resources for local development.

## Open in Xcode

```bash
open safari-app/JobTriageSafari.xcodeproj
```

Then in Xcode:

1. Set your Signing Team for both targets.
2. Build and run the `JobTriageSafari` macOS app target.
3. Enable the extension in Safari: `Settings > Extensions`.
