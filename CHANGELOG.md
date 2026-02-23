# Changelog

## [1.2.0] - 2026-02-23

### Added
- Background job orchestrator (`background.js`) with message-based lifecycle:
  - `START_YT_JOB`
  - `GET_YT_JOB_STATUS`
  - `CANCEL_YT_JOB`
- Persistent job state in `chrome.storage.local` (`ytBatchPublisher.jobState`).
- Auto-resume flow after reload using `chrome.tabs.onUpdated`.
- Tab-close abort handling using `chrome.tabs.onRemoved`.
- Status badges per run state (`RUN`, `DONE`, `ERR`).
- New popup UX with Start/Cancel controls, live status, and run summary.
- Settings persistence for visibility and made-for-kids.
- Extension icon set (16/32/48/128).
- Packaging and lint scripts in `package.json`.

### Changed
- Updated YouTube selectors to match current Studio UI with fallbacks for older selectors.
- Moved long automation execution from popup to background-managed chunked execution.
- Default execution strategy now uses chunk processing (`15` videos) + tab refresh + automatic resume.

### Fixed
- Improved resilience of success dialog closing via text-based match, generic fallback, and Escape key fallback.
- Reduced long-run page lag risk by refreshing between chunks and continuing from processed video ids.
- Continue-on-error behavior now preserves progress and reports partial failures.
