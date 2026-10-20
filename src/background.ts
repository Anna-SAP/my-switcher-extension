import {sanitizeGoogleAccountProfiles, syncGoogleAccountsMessageType} from '@/lib/google-accounts';

const listAccountsUrl =
  'https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&hl=en';
// A lightweight, script-free Google page: favicon loads fast and stays on www.google.com.
const helperPageUrl = 'https://www.google.com/favicon.ico';
const helperPageOrigin = 'https://www.google.com';
const tabLoadTimeoutMs = 15000;
const listAccountsTimeoutMs = 15000;
const maxSyncAttempts = 3;
const retryDelayMs = 400;
const helperTabInterruptedMessage =
  'The Google page closed or reloaded before accounts finished loading. Please try again.';

// Errors the browser reports when the helper tab's document goes away while the
// injected script is still running (Chrome and Firefox wording).
const helperTabInterruptedPattern =
  /frame with id \d+ (was removed|is not ready|is showing error page)|no frame with id|tab containing frame|no tab with id|frame was removed|tab was closed|message manager disconnected|destroyed before query/iu;

type RuntimeMessage = {
  type?: string;
};

type GoogleAccountProfile = {
  authuser: number;
  email: string;
  displayName: string;
  avatarUrl?: string;
};

type HelperTab = {
  id?: number;
  status?: string;
  url?: string;
};

type PageFetchResult = {ok: true; text: string} | {ok: false; error: string};

// The helper tab was closed, replaced or navigated before we got a result.
// These failures are transient, so the sync is retried with a fresh tab.
class HelperTabInterruptedError extends Error {}

// Access native browser APIs directly (not through the abstraction layer)
// because we need features like scripting.executeScript with world: 'MAIN'
const chromeApi = (globalThis as any).chrome ?? (globalThis as any).browser;

let pendingAccountsSync: Promise<GoogleAccountProfile[]> | null = null;

function toInjectionError(message: string | undefined): Error {
  const errorMessage = message ?? 'Script injection failed.';
  return helperTabInterruptedPattern.test(errorMessage)
    ? new HelperTabInterruptedError(errorMessage)
    : new Error(errorMessage);
}

function createHelperTab(): Promise<number> {
  return new Promise((resolve, reject) => {
    chromeApi.tabs.create({url: helperPageUrl, active: false}, (createdTab: HelperTab) => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(chromeApi.runtime.lastError.message));
        return;
      }
      if (typeof createdTab?.id !== 'number') {
        reject(new Error('Failed to create tab.'));
        return;
      }
      resolve(createdTab.id);
    });
  });
}

function waitForHelperPageLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const timeoutId = globalThis.setTimeout(() => {
      finish(new Error('Timed out while loading the Google page.'));
    }, tabLoadTimeoutMs);

    function finish(error?: Error) {
      if (isSettled) {
        return;
      }
      isSettled = true;
      globalThis.clearTimeout(timeoutId);
      chromeApi.tabs.onUpdated.removeListener(handleUpdated);
      chromeApi.tabs.onRemoved.removeListener(handleRemoved);
      chromeApi.tabs.onReplaced?.removeListener(handleReplaced);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function checkTab(tab: HelperTab | undefined) {
      if (tab?.status !== 'complete') {
        return;
      }
      // `url` is only visible while the tab is on a host we have permission for.
      // If the load ended somewhere else (consent/interstitial page), injecting
      // there would either fail or run against a document that is about to change.
      if (tab.url && !tab.url.startsWith(`${helperPageOrigin}/`)) {
        finish(new Error('Google redirected away from the account check page. Open google.com once, then try again.'));
        return;
      }
      finish();
    }

    function handleUpdated(updatedTabId: number, changeInfo: {status?: string}, tab: HelperTab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        checkTab(tab);
      }
    }

    function handleRemoved(removedTabId: number) {
      if (removedTabId === tabId) {
        finish(new HelperTabInterruptedError(`Tab ${tabId} was closed while loading.`));
      }
    }

    function handleReplaced(_addedTabId: number, removedTabId: number) {
      if (removedTabId === tabId) {
        finish(new HelperTabInterruptedError(`Tab ${tabId} was replaced while loading.`));
      }
    }

    chromeApi.tabs.onUpdated.addListener(handleUpdated);
    chromeApi.tabs.onRemoved.addListener(handleRemoved);
    chromeApi.tabs.onReplaced?.addListener(handleReplaced);

    // The page may have finished loading before the listeners were attached
    // (a cached favicon loads almost instantly), so check the current state too.
    chromeApi.tabs.get(tabId, (tab: HelperTab) => {
      if (chromeApi.runtime.lastError) {
        finish(new HelperTabInterruptedError(chromeApi.runtime.lastError.message));
        return;
      }
      checkTab(tab);
    });
  });
}

// This function runs in the Google page's MAIN world context.
// It has full access to the page's cookies via fetch credentials.
// It must stay self-contained (it is serialized into the page) and must not
// throw: page-level failures are returned as data so they can be told apart
// from the page itself going away mid-request.
async function fetchListAccountsInPageContext(
  url: string,
  timeoutMs: number,
): Promise<PageFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {ok: false, error: `ListAccounts request failed: ${response.status}`};
    }
    return {ok: true, text: await response.text()};
  } catch (error) {
    if (controller.signal.aborted) {
      return {ok: false, error: 'Timed out while contacting Google Accounts.'};
    }
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  } finally {
    clearTimeout(timeoutId);
  }
}

function runListAccountsInTab(tabId: number): Promise<PageFetchResult> {
  return new Promise((resolve, reject) => {
    chromeApi.scripting.executeScript(
      {
        target: {tabId},
        world: 'MAIN',
        func: fetchListAccountsInPageContext,
        args: [listAccountsUrl, listAccountsTimeoutMs],
      },
      (injectionResults: Array<{result?: unknown}> | undefined) => {
        if (chromeApi.runtime.lastError) {
          reject(toInjectionError(chromeApi.runtime.lastError.message));
          return;
        }

        const result = injectionResults?.[0]?.result as PageFetchResult | undefined;
        if (!result || typeof result.ok !== 'boolean') {
          // The script never settled in the page, e.g. its document went away.
          reject(new HelperTabInterruptedError('The injected script returned no result.'));
          return;
        }
        resolve(result);
      },
    );
  });
}

function parseListAccountsResponse(responseText: string): GoogleAccountProfile[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    const firstBracket = responseText.indexOf('[');
    const lastBracket = responseText.lastIndexOf(']');
    if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
      return [];
    }

    try {
      parsed = JSON.parse(responseText.slice(firstBracket, lastBracket + 1));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const accountList = findAccountArray(parsed);
  if (!accountList) {
    return [];
  }

  const accounts: GoogleAccountProfile[] = [];

  for (let index = 0; index < accountList.length; index += 1) {
    const entry = accountList[index];
    if (!Array.isArray(entry)) {
      continue;
    }

    const email = findEmailInEntry(entry);
    if (!email) {
      continue;
    }

    const displayName = findDisplayNameInEntry(entry, email);
    const avatarUrl = findAvatarInEntry(entry);

    accounts.push({
      authuser: index,
      email,
      displayName,
      avatarUrl: avatarUrl || undefined,
    });
  }

  return accounts;
}

function findAccountArray(parsed: unknown[]): unknown[][] | null {
  for (const element of parsed) {
    if (
      Array.isArray(element) &&
      element.length > 0 &&
      element.every((item) => Array.isArray(item))
    ) {
      return element as unknown[][];
    }
  }

  if (
    parsed.length > 0 &&
    parsed.every(
      (item) => Array.isArray(item) && item.length >= 4 && typeof item[0] === 'string',
    )
  ) {
    return parsed as unknown[][];
  }

  return null;
}

function findEmailInEntry(entry: unknown[]): string | null {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

  if (typeof entry[3] === 'string' && emailPattern.test(entry[3])) {
    return entry[3].trim().toLowerCase();
  }

  for (const field of entry) {
    if (typeof field === 'string' && emailPattern.test(field)) {
      return field.trim().toLowerCase();
    }
  }

  return null;
}

function findDisplayNameInEntry(entry: unknown[], email: string): string {
  if (typeof entry[2] === 'string' && entry[2].trim() && !entry[2].includes('@')) {
    return entry[2].trim();
  }

  for (const field of entry) {
    if (
      typeof field === 'string' &&
      field.trim() &&
      !field.includes('@') &&
      !field.startsWith('//') &&
      !field.startsWith('http') &&
      field !== 'gaia.l.a' &&
      field !== 'gaia.l.a.r'
    ) {
      return field.trim();
    }
  }

  return email;
}

function findAvatarInEntry(entry: unknown[]): string | undefined {
  for (const field of entry) {
    if (typeof field !== 'string') {
      continue;
    }

    const trimmed = field.trim();
    if (
      trimmed.startsWith('//') &&
      (trimmed.includes('googleusercontent.com') || trimmed.includes('google.com'))
    ) {
      return `https:${trimmed}`;
    }

    if (
      trimmed.startsWith('https://') &&
      (trimmed.includes('googleusercontent.com') || trimmed.includes('google.com')) &&
      (trimmed.includes('/photo') || trimmed.includes('/avatar') || trimmed.includes('lh3'))
    ) {
      return trimmed;
    }
  }

  return undefined;
}

async function loadGoogleAccountsOnce(): Promise<GoogleAccountProfile[]> {
  // Step 1: Open the helper Google page in a background tab
  const tabId = await createHelperTab();

  try {
    // Step 2: Wait until the helper page itself (not an intermediate document) has loaded
    await waitForHelperPageLoad(tabId);

    // Step 3: Execute fetch in the page's MAIN world.
    // Because the script runs in www.google.com's context,
    // fetch to accounts.google.com will include .google.com cookies automatically.
    // The browser keeps the injection open until the fetch settles, so the tab's
    // main frame has to survive the whole network round trip.
    const pageResult = await runListAccountsInTab(tabId);
    if (pageResult.ok === false) {
      throw new Error(pageResult.error);
    }

    if (!pageResult.text.trim()) {
      throw new Error('Please sign in to a Google account first.');
    }

    const accounts = parseListAccountsResponse(pageResult.text);
    if (accounts.length === 0) {
      throw new Error('Please sign in to a Google account first.');
    }

    return sanitizeGoogleAccountProfiles(accounts);
  } finally {
    // Step 4: Clean up the helper tab
    chromeApi.tabs.remove(tabId, () => {
      void chromeApi.runtime.lastError; // suppress error
    });
  }
}

async function loadGoogleAccounts(): Promise<GoogleAccountProfile[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loadGoogleAccountsOnce();
    } catch (error) {
      if (!(error instanceof HelperTabInterruptedError)) {
        throw error;
      }
      console.warn(
        `Google helper tab was interrupted (attempt ${attempt}/${maxSyncAttempts}).`,
        error.message,
      );
      if (attempt >= maxSyncAttempts) {
        throw new Error(helperTabInterruptedMessage);
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

// Share one in-flight sync between callers (e.g. a reopened popup clicking
// Refresh again) instead of opening several helper tabs at once.
function syncGoogleAccounts(): Promise<GoogleAccountProfile[]> {
  pendingAccountsSync ??= loadGoogleAccounts().finally(() => {
    pendingAccountsSync = null;
  });
  return pendingAccountsSync;
}

function handleRuntimeMessage(
  message: RuntimeMessage,
  _sender: unknown,
  sendResponse: (response: {accounts?: unknown; error?: string}) => void,
) {
  if (message?.type !== syncGoogleAccountsMessageType) {
    return false;
  }

  void syncGoogleAccounts()
    .then((accountProfiles) => {
      sendResponse({accounts: accountProfiles});
    })
    .catch((error) => {
      console.error('Failed to sync Google accounts.', error);
      sendResponse({
        error: error instanceof Error ? error.message : 'Failed to load Google accounts.',
      });
    });

  return true;
}

chromeApi?.runtime?.onMessage?.addListener?.(handleRuntimeMessage);
