# Job Triage Safari Extension

Web extension that scans job pages and uses OpenAI to extract:

- whether the page is a real JD
- sponsorship/clearance requirements
- years of experience requirements

The widget stays compact on non-JD pages and expands on detected JD pages.

## Repository layout

- `manifest.json`, `content.js`, `worker.js`, `icon1.png`: source of truth for extension logic
- `safari-app/`: Safari wrapper app + extension Xcode project

## Safari setup (recommended)

1. Open the project:

```bash
open safari-app/JobTriageSafari.xcodeproj
```

2. In Xcode, select the `JobTriageSafari` scheme and your Mac as target.
3. In `Signing & Capabilities`, set your Team for both targets:
   - `JobTriageSafari`
   - `JobTriageSafariExtension`
4. Run the app from Xcode (`Cmd+R`).
5. In Safari, open:
   - `Safari > Settings > Extensions`
6. Enable `Job Triage Safari`.
7. Open a job posting page and hard refresh (`Cmd+Shift+R`).

## Configure OpenAI key

1. Open any page where the widget appears.
2. Click `Set API key` in the widget.
3. Paste your OpenAI API key.

The key is stored in extension local storage.

For safety, leave this empty in code unless you explicitly want a local dev fallback:

```js
const OPENAI_API_KEY_FALLBACK = '';
```

## Dev workflow

When you update root extension files, sync Safari resources:

```bash
./safari-app/sync-extension-files.sh
```

Then rerun the app in Xcode.

## Chrome setup (optional)

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository root.

