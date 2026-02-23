const JOB_STORAGE_KEY = 'ytBatchPublisher.jobState';

const DEFAULT_SETTINGS = {
  visibility: 'Public',
  madeForKids: false,
  chunkSize: 15
};

const YT_CONFIG = {
  selectors: {
    videoRow: 'ytcp-video-row',
    draftModal: 'ytcp-uploads-dialog, .style-scope.ytcp-uploads-dialog',
    draftButton: 'ytcp-button.edit-draft-button, .edit-draft-button',
    madeForKidsGroup: '#audience ytkc-made-for-kids-select tp-yt-paper-radio-group, #made-for-kids-group',
    radioButton: 'tp-yt-paper-radio-button',
    visibilityStepper: '#step-title-3, #step-badge-3',
    visibilityButtons: '#privacy-radios, tp-yt-paper-radio-group',
    saveButton: '#done-button',
    legacyDialog: 'ytcp-dialog.ytcp-video-share-dialog, ytcp-video-share-dialog, paper-dialog#dialog',
    dialogFallback: 'ytcp-dialog[open], ytcp-video-share-dialog[open], paper-dialog[open]'
  },
  visibilityOrder: {
    Private: 'PRIVATE',
    Unlisted: 'UNLISTED',
    Public: 'PUBLIC'
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  const state = await getJobState();
  if (!state || state.tabId !== tabId || state.status !== 'reloading') {
    return;
  }

  if (!tab.url || !tab.url.includes('studio.youtube.com')) {
    await failJob('Target tab is no longer on YouTube Studio.');
    return;
  }

  await updateJobState({
    status: 'running',
    updatedAt: new Date().toISOString()
  });

  void processJobChunk(state.jobId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getJobState();
  if (!state || state.tabId !== tabId) {
    return;
  }

  if (state.status === 'running' || state.status === 'reloading') {
    await failJob('Target tab was closed while publishing drafts.');
  }
});

async function handleMessage(message) {
  if (!message || !message.action) {
    return { ok: false, error: 'Missing action.' };
  }

  switch (message.action) {
    case 'START_YT_JOB':
      return startJob(message);
    case 'GET_YT_JOB_STATUS': {
      const state = await getJobState();
      return { ok: true, state: state || null };
    }
    case 'CANCEL_YT_JOB':
      return cancelJob();
    case 'ACK_YT_JOB':
      return acknowledgeTerminalState();
    default:
      return { ok: false, error: `Unknown action: ${message.action}` };
  }
}

async function startJob(payload) {
  const current = await getJobState();
  if (current && (current.status === 'running' || current.status === 'reloading')) {
    return { ok: false, error: 'A publishing job is already running.' };
  }

  const tabId = Number(payload.tabId);
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'Invalid tab id.' };
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !tab.url.includes('studio.youtube.com')) {
    return { ok: false, error: 'Please open YouTube Studio in the target tab first.' };
  }

  const chunkSize = sanitizeChunkSize(payload.chunkSize);
  const settings = sanitizeSettings(payload.settings, chunkSize);

  const nowIso = new Date().toISOString();
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nextState = {
    jobId,
    status: 'running',
    tabId,
    chunkSize,
    settings,
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
    totalDraftsSeen: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
    lastError: null,
    stalled: false,
    badgeAcknowledged: false,
    processedVideoIds: [],
    noProgressCount: 0,
    reloadCount: 0
  };

  await setJobState(nextState);
  await setBadge(tabId, 'RUN', '#1a73e8');

  void processJobChunk(jobId);

  return { ok: true, jobId };
}

async function cancelJob() {
  const state = await getJobState();
  if (!state) {
    return { ok: true };
  }

  const nowIso = new Date().toISOString();
  const cancelled = {
    ...state,
    status: 'cancelled',
    updatedAt: nowIso,
    finishedAt: nowIso,
    stalled: false,
    lastError: null
  };

  await setJobState(cancelled);
  await clearBadge(state.tabId);

  return { ok: true };
}

async function acknowledgeTerminalState() {
  const state = await getJobState();
  if (!state) {
    return { ok: true, state: null };
  }

  const terminalStatuses = ['completed', 'error', 'stalled', 'cancelled'];
  if (!terminalStatuses.includes(state.status)) {
    return { ok: true, state };
  }

  if (!state.badgeAcknowledged) {
    await clearBadge(state.tabId);
    const updated = {
      ...state,
      badgeAcknowledged: true,
      updatedAt: new Date().toISOString()
    };
    await setJobState(updated);
    return { ok: true, state: updated };
  }

  return { ok: true, state };
}

async function processJobChunk(jobId) {
  const state = await getJobState();
  if (!state || state.jobId !== jobId || state.status !== 'running') {
    return;
  }

  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab || !tab.url || !tab.url.includes('studio.youtube.com')) {
    await failJob('Target tab is unavailable or not on YouTube Studio.');
    return;
  }

  let chunkResult;
  try {
    chunkResult = await executeChunk(state);
  } catch (error) {
    await failJob(`Chunk execution failed: ${error.message}`);
    return;
  }

  if (!chunkResult.ok) {
    await failJob(chunkResult.error || 'Chunk execution failed.');
    return;
  }

  const latestState = await getJobState();
  if (!latestState || latestState.jobId !== jobId || latestState.status !== 'running') {
    return;
  }

  const result = chunkResult.result;
  const mergedIds = dedupeArray((latestState.processedVideoIds || []).concat(result.processedIdsChunk || []));
  const mergedFailures = mergeFailures(latestState.failures || [], result.failures || []);
  const noProgressCount = result.attempted === 0 && result.remainingDrafts > 0
    ? (latestState.noProgressCount || 0) + 1
    : 0;

  const updatedState = {
    ...latestState,
    processedVideoIds: mergedIds,
    failures: mergedFailures,
    totalDraftsSeen: Math.max(latestState.totalDraftsSeen || 0, result.scannedDrafts || 0),
    attempted: (latestState.attempted || 0) + (result.attempted || 0),
    succeeded: (latestState.succeeded || 0) + (result.succeeded || 0),
    failed: (latestState.failed || 0) + (result.failed || 0),
    updatedAt: new Date().toISOString(),
    noProgressCount,
    lastError: null
  };

  if (result.remainingDrafts > 0) {
    if (noProgressCount >= 2) {
      const stalledState = {
        ...updatedState,
        status: 'stalled',
        stalled: true,
        badgeAcknowledged: false,
        finishedAt: new Date().toISOString(),
        lastError: 'Publisher stalled because no progress was made across two consecutive chunks.'
      };
      await setJobState(stalledState);
      await setBadge(stalledState.tabId, 'ERR', '#d93025');
      return;
    }

    const reloadingState = {
      ...updatedState,
      status: 'reloading',
      reloadCount: (latestState.reloadCount || 0) + 1
    };

    await setJobState(reloadingState);
    await chrome.tabs.reload(reloadingState.tabId);
    return;
  }

  const finishedState = {
    ...updatedState,
    status: 'completed',
    stalled: false,
    badgeAcknowledged: false,
    finishedAt: new Date().toISOString()
  };

  await setJobState(finishedState);
  await setBadge(finishedState.tabId, 'DONE', '#188038');
}

async function executeChunk(state) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    func: runPublishChunk,
    args: [
      YT_CONFIG,
      state.settings,
      {
        chunkSize: state.chunkSize,
        processedVideoIds: state.processedVideoIds || []
      }
    ]
  });

  const result = Array.isArray(injection) && injection[0] ? injection[0].result : null;
  if (!result) {
    return { ok: false, error: 'Injected script did not return a result.' };
  }

  if (result.error) {
    return { ok: false, error: result.error };
  }

  return { ok: true, result };
}

async function failJob(message) {
  const state = await getJobState();
  if (!state) {
    return;
  }

  const nowIso = new Date().toISOString();
  const failedState = {
    ...state,
    status: 'error',
    updatedAt: nowIso,
    finishedAt: nowIso,
    stalled: false,
    badgeAcknowledged: false,
    lastError: message
  };

  await setJobState(failedState);
  await setBadge(failedState.tabId, 'ERR', '#d93025');
}

function sanitizeChunkSize(chunkSize) {
  const parsed = Number(chunkSize);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SETTINGS.chunkSize;
  }
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function sanitizeSettings(settings, chunkSize) {
  const visibility = ['Public', 'Unlisted', 'Private'].includes(settings?.visibility)
    ? settings.visibility
    : DEFAULT_SETTINGS.visibility;

  return {
    visibility,
    madeForKids: Boolean(settings?.madeForKids),
    chunkSize
  };
}

function dedupeArray(items) {
  return Array.from(new Set(items));
}

function mergeFailures(existing, incoming) {
  const all = existing.concat(incoming);
  if (all.length <= 100) {
    return all;
  }
  return all.slice(all.length - 100);
}

async function getJobState() {
  const result = await chrome.storage.local.get([JOB_STORAGE_KEY]);
  return result[JOB_STORAGE_KEY] || null;
}

async function setJobState(state) {
  await chrome.storage.local.set({ [JOB_STORAGE_KEY]: state });
}

async function updateJobState(patch) {
  const current = await getJobState();
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch
  };

  await setJobState(next);
  return next;
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_error) {
    // Ignore badge errors (e.g. tab no longer exists)
  }
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (_error) {
    // Ignore badge errors
  }
}

function runPublishChunk(config, settings, chunkState) {
  const selectors = config.selectors;
  const visibilityOrder = config.visibilityOrder;
  const visibility = settings.visibility || 'Public';
  const madeForKids = Boolean(settings.madeForKids);
  const chunkSize = Math.max(1, Number(chunkState.chunkSize) || 15);
  const processedSet = new Set(Array.isArray(chunkState.processedVideoIds) ? chunkState.processedVideoIds : []);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const simpleHash = (input) => {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  };

  const normalizeText = (value) => (
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );

  const extractUrlFromCssValue = (value) => {
    const match = String(value || '').match(/url\((['"]?)(.*?)\1\)/i);
    return match && match[2] ? match[2] : null;
  };

  const normalizeUrlForIdentity = (value) => {
    if (!value) {
      return '';
    }

    try {
      const parsed = new URL(value, location.origin);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_error) {
      return String(value).split('?')[0].split('#')[0];
    }
  };

  const collectRowUrlCandidates = (row) => {
    const urlCandidates = [];

    const links = Array.from(row.querySelectorAll('a[href]'));
    for (const link of links) {
      if (link.href) {
        urlCandidates.push(link.href);
      }
    }

    const mediaNodes = Array.from(row.querySelectorAll('img[src], source[src], [style*="background-image"]'));
    for (const node of mediaNodes) {
      if (node.src) {
        urlCandidates.push(node.src);
      }

      const bgRaw = node.style?.backgroundImage || '';
      const bgUrl = extractUrlFromCssValue(bgRaw);
      if (bgUrl) {
        urlCandidates.push(bgUrl);
      }
    }

    return urlCandidates;
  };

  const getRowTitleKey = (row) => normalizeText(
    row.querySelector('#video-title, .label.ytcp-video-row')?.textContent || ''
  );

  const getRowDurationKey = (row) => normalizeText(
    row.querySelector('ytd-thumbnail-overlay-time-status-renderer, .ytd-thumbnail-overlay-time-status-renderer')?.textContent || ''
  );

  const extractVideoIdFromUrl = (value) => {
    if (!value) {
      return null;
    }

    const patterns = [
      /\/video\/([^/?&#]+)/i,
      /[?&]v=([^&]+)/i,
      /\/vi\/([^/?&#]+)/i
    ];

    for (const pattern of patterns) {
      const match = String(value).match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  };

  const getPrimaryVideoId = (row, urlCandidates = []) => {
    const direct =
      row.getAttribute('video-id') ||
      row.getAttribute('data-video-id') ||
      row.dataset?.videoId ||
      row.dataset?.id;

    if (direct) {
      return direct;
    }

    const embeddedIdElement = row.querySelector('[video-id], [data-video-id], [data-videoid]');
    if (embeddedIdElement) {
      const embeddedId = embeddedIdElement.getAttribute('video-id') ||
        embeddedIdElement.getAttribute('data-video-id') ||
        embeddedIdElement.getAttribute('data-videoid');
      if (embeddedId) {
        return embeddedId;
      }
    }

    for (const candidate of urlCandidates) {
      const extracted = extractVideoIdFromUrl(candidate);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  };

  const click = (element) => {
    if (!element) {
      return;
    }
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.click();
  };

  const waitForElement = (selector, root = document, timeoutMs = 10000) => {
    return new Promise((resolve) => {
      const host = root || document;
      const immediate = host.querySelector(selector);
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observerTarget = host === document ? document.documentElement : host;
      if (!observerTarget) {
        resolve(null);
        return;
      }

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        if (settled) {
          return;
        }
        const found = host.querySelector(selector);
        if (found) {
          settled = true;
          clearTimeout(timeoutId);
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(observerTarget, { subtree: true, childList: true });
    });
  };

  const identifierForRow = (row, index) => {
    const urlCandidates = collectRowUrlCandidates(row);
    const primaryId = getPrimaryVideoId(row, urlCandidates);
    if (primaryId) {
      return `id:${primaryId}`;
    }

    const title = getRowTitleKey(row);
    const duration = getRowDurationKey(row);
    const mediaIdentity = normalizeUrlForIdentity(urlCandidates[0] || '');
    const identityParts = [title, duration, mediaIdentity].filter(Boolean);
    const fallbackSeed = identityParts.length > 0 ? identityParts.join('|') : `row:${index}`;
    const digest = simpleHash(fallbackSeed);
    return `fallback:${digest}`;
  };

  const findOpenDialog = () => (
    document.querySelector(selectors.dialogFallback) ||
    document.querySelector(selectors.legacyDialog)
  );

  const waitForDialogToClose = async (timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!findOpenDialog()) {
        return true;
      }
      await sleep(100);
    }
    return !findOpenDialog();
  };

  const closeSuccessDialog = async () => {
    await sleep(300);

    const dialog = findOpenDialog();

    if (dialog) {
      const strictCandidates = Array.from(
        dialog.querySelectorAll(
          '#close-button, ytcp-icon-button#close-button, button#close-button, button[aria-label*=\"close\" i], ytcp-button[dialog-action=\"close\" i], tp-yt-paper-button[dialog-action=\"close\" i], button[dialog-action=\"close\" i]'
        )
      );

      for (const button of strictCandidates) {
        click(button);
        if (await waitForDialogToClose()) {
          return true;
        }
      }

      const textCandidates = Array.from(dialog.querySelectorAll('ytcp-button, tp-yt-paper-button, button'));
      for (const button of textCandidates) {
        const label = (button.textContent || '').trim().toLowerCase();
        const isCloseLike = ['ok', 'close', 'done', 'got it', 'understood'].some(
          (keyword) => label === keyword || label.includes(keyword)
        );
        const riskyShareLabel = ['whatsapp', 'facebook', 'reddit', 'pinterest', 'x', 'email', 'copy'].some(
          (word) => label.includes(word)
        );
        if (isCloseLike && !riskyShareLabel) {
          click(button);
          if (await waitForDialogToClose()) {
            return true;
          }
        }
      }
    }

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true
      })
    );
    await sleep(250);
    return waitForDialogToClose(2500);
  };

  const ensureNoBlockingDialog = async () => {
    if (!findOpenDialog()) {
      return true;
    }
    return closeSuccessDialog();
  };

  const rowLooksProcessing = (row) => {
    if (!row) {
      return false;
    }

    const indicatorSelector = [
      'ytcp-video-row-upload-progress',
      'ytcp-video-upload-progress',
      '[role="progressbar"]',
      '[aria-valuenow]',
      'tp-yt-paper-progress',
      'ytcp-badge[badge-style-type="BADGE_STYLE_TYPE_IN_PROGRESS"]',
      '[data-state="processing"]',
      '[data-status="processing"]'
    ].join(', ');

    if (row.querySelector(indicatorSelector)) {
      return true;
    }

    const text = normalizeText(row.textContent || '');
    const processingKeywords = [
      'processing',
      'işleniyor',
      'proces',
      'trait',
      'verarbeit',
      'elabora',
      'обработ',
      '処理',
      '처리'
    ];

    return processingKeywords.some((keyword) => text.includes(keyword));
  };

  const collectDraftEntries = () => {
    const rows = Array.from(document.querySelectorAll(selectors.videoRow));
    const entries = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const draftBtn = row.querySelector(selectors.draftButton);
      if (!draftBtn) {
        continue;
      }

      const videoId = identifierForRow(row, i);
      entries.push({
        videoId,
        isProcessing: rowLooksProcessing(row)
      });
    }

    return entries;
  };

  const findDraftTargetByVideoId = (videoId) => {
    const rows = Array.from(document.querySelectorAll(selectors.videoRow));
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const currentId = identifierForRow(row, i);
      if (currentId !== videoId) {
        continue;
      }
      const draftBtn = row.querySelector(selectors.draftButton);
      if (draftBtn) {
        return {
          row,
          draftBtn,
          isProcessing: rowLooksProcessing(row)
        };
      }
    }
    return null;
  };

  const openDraftModalWithRetry = async (videoId, maxAttempts = 3) => {
    let latestTarget = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const residualClosed = await ensureNoResidualDraftModal();
      if (!residualClosed) {
        await sleep(180);
        continue;
      }

      latestTarget = findDraftTargetByVideoId(videoId);
      if (!latestTarget) {
        await sleep(180);
        continue;
      }

      latestTarget.row.scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(120);
      click(latestTarget.draftBtn);

      const modal = await waitForActiveDraftModal(4500);
      if (modal) {
        return { modal, target: latestTarget };
      }

      await ensureNoBlockingDialog();
      await sleep(220 * attempt);
    }

    return { modal: null, target: latestTarget };
  };

  const isElementVisible = (element) => {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return element.getClientRects().length > 0;
  };

  const findActiveDraftModal = () => {
    const modals = Array.from(document.querySelectorAll(selectors.draftModal));
    for (const modal of modals) {
      if (!modal) {
        continue;
      }
      const ariaHidden = modal.getAttribute('aria-hidden');
      const openAttr = modal.hasAttribute('open') || modal.getAttribute('opened') === 'true';
      const doneButton = modal.querySelector(selectors.saveButton);
      if (ariaHidden === 'true') {
        continue;
      }
      if (openAttr || isElementVisible(modal) || isElementVisible(doneButton)) {
        return modal;
      }
    }
    return null;
  };

  const waitForDraftModalToClose = async (initialModal, timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const activeModal = findActiveDraftModal();
      if (!activeModal) {
        return true;
      }
      if (initialModal && activeModal !== initialModal) {
        return true;
      }
      await sleep(100);
    }
    return !findActiveDraftModal();
  };

  const waitForActiveDraftModal = async (timeoutMs = 6000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const activeModal = findActiveDraftModal();
      if (activeModal) {
        return activeModal;
      }
      await sleep(100);
    }
    return null;
  };

  const closeDraftModal = async (modal) => {
    if (!modal) {
      return true;
    }

    const strictCloseSelectors = [
      '#close-button',
      'ytcp-icon-button#close-button',
      'tp-yt-paper-icon-button#close-button',
      'button#close-button',
      'button[aria-label*="close" i]',
      'ytcp-button[aria-label*="close" i]',
      'tp-yt-paper-button[aria-label*="close" i]',
      'ytcp-button[dialog-action="cancel" i]',
      'tp-yt-paper-button[dialog-action="cancel" i]',
      'button[dialog-action="cancel" i]'
    ];

    for (const selector of strictCloseSelectors) {
      const button = modal.querySelector(selector);
      if (!button) {
        continue;
      }
      click(button);
      if (await waitForDraftModalToClose(modal, 2500)) {
        return true;
      }
    }

    // Fallback: Esc often closes stuck draft modals in YouTube Studio.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true
      })
    );

    return waitForDraftModalToClose(modal, 2500);
  };

  const ensureNoResidualDraftModal = async () => {
    const activeModal = findActiveDraftModal();
    if (!activeModal) {
      return true;
    }
    return closeDraftModal(activeModal);
  };

  const waitForPostSaveSignal = async (initialModal, timeoutMs = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (findOpenDialog()) {
        return 'dialog';
      }
      const activeModal = findActiveDraftModal();
      if (!activeModal || (initialModal && activeModal !== initialModal)) {
        return 'modal_closed';
      }
      await sleep(100);
    }
    return 'timeout';
  };

  const setAudience = async (modal) => {
    const group = await waitForElement(selectors.madeForKidsGroup, modal, 4000);
    if (!group) {
      return;
    }

    const radios = Array.from(group.querySelectorAll(selectors.radioButton));
    const index = madeForKids ? 0 : 1;
    if (radios[index]) {
      click(radios[index]);
      await sleep(120);
    }
  };

  const setVisibility = async (modal) => {
    const stepper = await waitForElement(selectors.visibilityStepper, modal, 4000);
    if (!stepper) {
      throw new Error('Visibility step could not be opened.');
    }

    click(stepper);
    await sleep(250);

    const group = await waitForElement(selectors.visibilityButtons, modal, 6000);
    if (!group) {
      throw new Error('Visibility options were not found.');
    }

    let radio = null;
    const visibilityName = visibilityOrder[visibility];
    if (visibilityName) {
      radio = group.querySelector(`${selectors.radioButton}[name="${visibilityName}"]`);
    }

    if (!radio) {
      const fallbackOrder = { Private: 0, Unlisted: 1, Public: 2 };
      const radios = Array.from(group.querySelectorAll(selectors.radioButton));
      radio = radios[fallbackOrder[visibility]] || null;
    }

    if (!radio) {
      throw new Error(`Visibility radio button not found for ${visibility}.`);
    }

    click(radio);
    await sleep(150);
  };

  const saveDraft = async (modal) => {
    const saveBtn = await waitForElement(selectors.saveButton, modal, 6000);
    if (!saveBtn) {
      throw new Error('Done button not found.');
    }

    click(saveBtn);
    const signal = await waitForPostSaveSignal(modal, 12000);

    if (signal === 'dialog') {
      const closed = await closeSuccessDialog();
      if (!closed) {
        throw new Error('Success dialog could not be closed.');
      }
      const modalClosedAfterDialog = await waitForDraftModalToClose(modal, 10000);
      if (!modalClosedAfterDialog) {
        throw new Error('Draft modal did not close after success dialog.');
      }
    } else if (signal === 'modal_closed') {
      // Save flow completed without a visible success dialog.
    } else {
      const forceClosedDialog = await ensureNoBlockingDialog();
      if (!forceClosedDialog) {
        throw new Error('Save confirmation timed out and dialog could not be closed.');
      }
      const modalClosed = await waitForDraftModalToClose(modal, 8000);
      if (!modalClosed) {
        throw new Error('Save confirmation timed out.');
      }
    }

    await sleep(120);
  };

  const processDraft = async (item) => {
    const wasClosed = await ensureNoBlockingDialog();
    if (!wasClosed) {
      throw new Error('A blocking dialog could not be closed.');
    }

    const residualClosed = await ensureNoResidualDraftModal();
    if (!residualClosed) {
      throw new Error('A previous draft modal is still open and could not be closed.');
    }

    const opened = await openDraftModalWithRetry(item.videoId, 3);
    const modal = opened.modal;
    if (!modal) {
      if (opened.target && opened.target.isProcessing) {
        throw new Error('Video is still processing and draft editor is not ready yet.');
      }
      throw new Error('Draft modal did not appear.');
    }

    await setAudience(modal);
    await setVisibility(modal);
    await saveDraft(modal);
  };

  return (async () => {
    try {
      if (!location.href.includes('studio.youtube.com')) {
        return { error: 'Target tab is no longer on YouTube Studio.' };
      }

      await ensureNoBlockingDialog();

      const drafts = collectDraftEntries();

      const pending = drafts.filter((draft) => !processedSet.has(draft.videoId));
      const targets = pending.slice(0, chunkSize);

      let attempted = 0;
      let succeeded = 0;
      let failed = 0;
      const failures = [];
      const processedIdsChunk = [];

      for (const draft of targets) {
        attempted += 1;
        processedIdsChunk.push(draft.videoId);

        if (draft.isProcessing) {
          failed += 1;
          failures.push({
            videoId: draft.videoId,
            reason: 'Video is still processing and not ready for publishing.'
          });
          continue;
        }

        try {
          await processDraft(draft);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          failures.push({
            videoId: draft.videoId,
            reason: error && error.message ? error.message : 'Unknown error'
          });
        }

        await sleep(120);
      }

      const remainingDrafts = Math.max(0, pending.length - attempted);

      return {
        scannedDrafts: drafts.length,
        attempted,
        succeeded,
        failed,
        failures,
        processedIdsChunk,
        remainingDrafts,
        completed: remainingDrafts === 0
      };
    } catch (error) {
      return {
        error: error && error.message ? error.message : 'Unexpected chunk execution error'
      };
    }
  })();
}
