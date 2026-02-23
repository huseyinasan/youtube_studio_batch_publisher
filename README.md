# YouTube Batch Publisher

Chrome extension for batch publishing YouTube Studio draft videos with resilient background execution.

## Features
- Batch publish draft videos in YouTube Studio.
- Visibility control: `Public`, `Unlisted`, `Private`.
- Optional `Made for kids` toggle.
- Background job runner (continues even if popup closes).
- Chunked processing with auto-refresh and auto-resume (default chunk size: `15`).
- Continue-on-error behavior with summary of successes/failures.

## How It Works
1. Open YouTube Studio content page (`https://studio.youtube.com`).
2. Open extension popup and choose settings.
3. Click **Start Batch Publish**.
4. Extension processes up to 15 drafts, refreshes the tab, and resumes automatically.
5. You can switch to other tabs while the job continues on the target YouTube tab.

## Load Unpacked
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/lekegames/Desktop/Projects/youtube_studio_batch_publisher`

## Packaging
```bash
npm run package
```

This creates a zip file for submission testing.

## Scripts
```bash
npm run lint
npm run package
```

## Troubleshooting
- If start fails, make sure the active tab is on `studio.youtube.com`.
- Keep at least one YouTube Studio tab open while processing.
- If state is stuck, use **Cancel**, then start again.
- If YouTube UI changes, selectors may need updates in `background.js`.

## Permissions
- `activeTab`
- `scripting`
- `storage`
- `tabs`
- Host: `https://studio.youtube.com/*`
