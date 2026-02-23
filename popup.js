const SETTINGS_KEY = 'ytBatchPublisher.settings';
const DEFAULT_SETTINGS = {
  visibility: 'Public',
  madeForKids: false,
  chunkSize: 15
};

class SettingsStore {
  async load() {
    const result = await chrome.storage.sync.get([SETTINGS_KEY]);
    return {
      ...DEFAULT_SETTINGS,
      ...(result[SETTINGS_KEY] || {})
    };
  }

  async save(partial) {
    const next = {
      ...DEFAULT_SETTINGS,
      ...(partial || {})
    };
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    return next;
  }
}

class PopupController {
  constructor() {
    this.settingsStore = new SettingsStore();
    this.pollTimer = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.lastAcknowledgedJobId = null;

    this.elements = {
      visibility: document.getElementById('visibility-select'),
      madeForKids: document.getElementById('made-for-kids'),
      start: document.getElementById('run-start'),
      cancel: document.getElementById('run-cancel'),
      status: document.getElementById('run-status'),
      progress: document.getElementById('run-progress'),
      summary: document.getElementById('run-summary'),
      error: document.getElementById('run-error')
    };
  }

  async init() {
    try {
      this.settings = await this.settingsStore.load();
      this.applySettingsToUI();
      this.bindEvents();

      await this.refreshStatus();
      this.pollTimer = setInterval(() => {
        this.refreshStatus();
      }, 1500);
    } catch (error) {
      this.renderError(`Initialization failed: ${error.message}`);
      this.updateStatus('error', 'Initialization failed');
    }
  }

  bindEvents() {
    this.elements.start.addEventListener('click', () => {
      this.startJob();
    });

    this.elements.cancel.addEventListener('click', () => {
      this.cancelJob();
    });

    this.elements.visibility.addEventListener('change', () => {
      this.saveSettingsFromUI();
    });

    this.elements.madeForKids.addEventListener('change', () => {
      this.saveSettingsFromUI();
    });

    window.addEventListener('beforeunload', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  applySettingsToUI() {
    this.elements.visibility.value = this.settings.visibility;
    this.elements.madeForKids.checked = this.settings.madeForKids;
  }

  async saveSettingsFromUI() {
    this.settings = {
      ...this.settings,
      visibility: this.elements.visibility.value,
      madeForKids: this.elements.madeForKids.checked,
      chunkSize: DEFAULT_SETTINGS.chunkSize
    };
    await this.settingsStore.save(this.settings);
  }

  async startJob() {
    try {
      this.renderError('');
      this.updateStatus('running', 'Starting...');
      this.setButtons({ startDisabled: true, cancelDisabled: true });

      await this.saveSettingsFromUI();

      const tab = await this.getActiveTab();
      if (!tab || !tab.id || !tab.url || !tab.url.includes('studio.youtube.com')) {
        this.updateStatus('error', 'Open YouTube Studio in the current tab first');
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        return;
      }

      const response = await this.sendMessage({
        action: 'START_YT_JOB',
        tabId: tab.id,
        settings: {
          visibility: this.settings.visibility,
          madeForKids: this.settings.madeForKids
        },
        chunkSize: this.settings.chunkSize
      });

      if (!response.ok) {
        this.updateStatus('error', 'Could not start job');
        this.renderError(response.error || 'Unknown error');
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        return;
      }

      await this.refreshStatus();
    } catch (error) {
      this.updateStatus('error', 'Could not start job');
      this.renderError(error.message);
      this.setButtons({ startDisabled: false, cancelDisabled: true });
    }
  }

  async cancelJob() {
    try {
      const response = await this.sendMessage({ action: 'CANCEL_YT_JOB' });
      if (!response.ok) {
        this.renderError(response.error || 'Cancel failed');
      }
      await this.refreshStatus();
    } catch (error) {
      this.renderError(error.message);
    }
  }

  async refreshStatus() {
    try {
      const response = await this.sendMessage({ action: 'GET_YT_JOB_STATUS' });
      if (!response.ok) {
        this.updateStatus('error', 'Status check failed');
        this.renderError(response.error || 'Unable to read status');
        return;
      }

      this.renderState(response.state);
    } catch (error) {
      this.updateStatus('error', 'Status check failed');
      this.renderError(error.message);
    }
  }

  renderState(state) {
    if (!state) {
      this.updateStatus('ready', 'Ready');
      this.elements.progress.textContent = '';
      this.elements.summary.textContent = 'No runs yet.';
      this.renderError('');
      this.setButtons({ startDisabled: false, cancelDisabled: true });
      return;
    }

    this.renderSummary(state);
    this.renderError(state.lastError || '');

    switch (state.status) {
      case 'running':
        this.updateStatus('running', 'Running in background');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: true, cancelDisabled: false });
        break;
      case 'reloading':
        this.updateStatus('reloading', 'Refreshing tab and resuming');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: true, cancelDisabled: false });
        break;
      case 'completed':
        this.updateStatus('success', 'Completed');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        this.acknowledgeTerminalBadge(state);
        break;
      case 'cancelled':
        this.updateStatus('cancelled', 'Cancelled');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        this.acknowledgeTerminalBadge(state);
        break;
      case 'stalled':
        this.updateStatus('error', 'Stalled');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        this.acknowledgeTerminalBadge(state);
        break;
      case 'error':
        this.updateStatus('error', 'Error');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        this.acknowledgeTerminalBadge(state);
        break;
      default:
        this.updateStatus('ready', 'Ready');
        this.elements.progress.textContent = this.progressText(state);
        this.setButtons({ startDisabled: false, cancelDisabled: true });
        break;
    }
  }

  renderSummary(state) {
    const duration = this.formatDuration(state.startedAt, state.finishedAt);
    const summaryHtml = [
      `<div><strong>Total drafts seen:</strong> ${state.totalDraftsSeen || 0}</div>`,
      `<div><strong>Attempted:</strong> ${state.attempted || 0}</div>`,
      `<div><strong>Succeeded:</strong> ${state.succeeded || 0}</div>`,
      `<div><strong>Failed:</strong> ${state.failed || 0}</div>`,
      `<div><strong>Reload cycles:</strong> ${state.reloadCount || 0}</div>`,
      `<div><strong>Duration:</strong> ${duration}</div>`
    ];

    if (Array.isArray(state.failures) && state.failures.length > 0) {
      const latestFailure = state.failures[state.failures.length - 1];
      summaryHtml.push(
        `<div><strong>Latest failure:</strong> ${this.escapeHtml(latestFailure.videoId || 'unknown')} - ${this.escapeHtml(latestFailure.reason || 'unknown')}</div>`
      );
    }

    this.elements.summary.innerHTML = summaryHtml.join('');
  }

  progressText(state) {
    const attempted = state.attempted || 0;
    const succeeded = state.succeeded || 0;
    const failed = state.failed || 0;
    return `Attempted ${attempted} | Succeeded ${succeeded} | Failed ${failed}`;
  }

  updateStatus(className, text) {
    this.elements.status.className = `status ${className}`;
    this.elements.status.textContent = text;
  }

  renderError(message) {
    this.elements.error.textContent = message || '';
  }

  acknowledgeTerminalBadge(state) {
    if (!state || !state.jobId) {
      return;
    }

    const terminalStatuses = ['completed', 'error', 'stalled', 'cancelled'];
    if (!terminalStatuses.includes(state.status)) {
      return;
    }

    if (state.badgeAcknowledged || this.lastAcknowledgedJobId === state.jobId) {
      return;
    }

    this.lastAcknowledgedJobId = state.jobId;
    this.sendMessage({ action: 'ACK_YT_JOB' }).catch(() => {
      // Ignore transient popup close/runtime errors
    });
  }

  setButtons({ startDisabled, cancelDisabled }) {
    this.elements.start.disabled = Boolean(startDisabled);
    this.elements.cancel.disabled = Boolean(cancelDisabled);
  }

  async getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response || { ok: false, error: 'No response from background script.' });
      });
    });
  }

  formatDuration(startedAt, finishedAt) {
    if (!startedAt) {
      return '0s';
    }

    const startMs = Date.parse(startedAt);
    const endMs = finishedAt ? Date.parse(finishedAt) : Date.now();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return '0s';
    }

    const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remSeconds}s` : `${remSeconds}s`;
  }

  escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const controller = new PopupController();
  controller.init();
});
