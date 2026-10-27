// background.js
// Note: In production run npm install yjs and bundle via esbuild/webpack.
// For mockup demonstration, we assume a standard ES module import structure.
import * as Y from './yjs.js'; 
import { getFractionalPositionAtIndex, generatePositionBetween } from './fractionalIndex.js';

const doc = new Y.Doc();
const yWindows = doc.getMap('windows');
const yTabs = doc.getMap('tabs');

const chromeToCrdtIdMap = new Map();
const lastSyncedUrlCache = new Map();
let isApplyingRemoteUpdates = false;

async function getSortedLocalPositionsForWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs
    .map(t => chromeToCrdtIdMap.get(t.id))
    .filter(Boolean)
    .map(uuid => yTabs.get(uuid)?.get('position'))
    .filter(Boolean)
    .sort();
}

// -------------------------------------------------------------
// INCOGNITO COMPLIANCE FILTERS
// -------------------------------------------------------------
async function isIncognitoTabOrWindow(tabId, windowId) {
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.incognito) return true;
    } catch (e) {}
  }
  if (windowId) {
    try {
      const win = await chrome.windows.get(windowId);
      if (win.incognito) return true;
    } catch (e) {}
  }
  return false;
}

// -------------------------------------------------------------
// CHROME INTERFACE EVENT LISTENERS
// -------------------------------------------------------------
chrome.tabs.onCreated.addListener(async (tab) => {
  if (isApplyingRemoteUpdates) return;
  if (tab.incognito) return; // Strict block on incognito activity creation

  const tabUuid = crypto.randomUUID();
  chromeToCrdtIdMap.set(tab.id, tabUuid);
  
  const sortedPositions = await getSortedLocalPositionsForWindow(tab.windowId);
  const fractionalPos = getFractionalPositionAtIndex(sortedPositions, tab.index);

  doc.transact(() => {
    const yTab = new Y.Map();
    yTab.set('id', tabUuid);
    yTab.set('windowId', String(tab.windowId));
    yTab.set('url', tab.pendingUrl || tab.url);
    yTab.set('title', tab.title || '');
    yTab.set('position', fractionalPos);
    yTab.set('isPinned', tab.pinned);
    yTabs.set(tabUuid, yTab);
  });
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  if (isApplyingRemoteUpdates) return;
  if (await isIncognitoTabOrWindow(tabId, moveInfo.windowId)) return;

  const tabUuid = chromeToCrdtIdMap.get(tabId);
  if (!tabUuid) return;

  const sortedPositions = await getSortedLocalPositionsForWindow(moveInfo.windowId);
  const targetPos = getFractionalPositionAtIndex(sortedPositions, moveInfo.toIndex);

  doc.transact(() => {
    const yTab = yTabs.get(tabUuid);
    if (yTab) yTab.set('position', targetPos);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const tabUuid = chromeToCrdtIdMap.get(tabId);
  if (!tabUuid) return;

  if (!isApplyingRemoteUpdates) {
    doc.transact(() => {
      yTabs.delete(tabUuid);
    });
  }
  chromeToCrdtIdMap.delete(tabId);
  lastSyncedUrlCache.delete(tabUuid);
});

// -------------------------------------------------------------
// RECONCILIATION LOOP WITH INPUT ISOLATION FILTERING
// -------------------------------------------------------------
async function reconciliateNativeBrowserUI() {
  const currentCrdtTabs = yTabs.toJSON();
  const nativeWindows = await chrome.windows.getAll({ populate: true });
  const windowsWithRemainingTabs = new Set();

  for (const win of nativeWindows) {
    if (win.incognito) continue; // Bypass structural verification for private setups
    let activeCrdtTabsCountInWindow = 0;

    for (const nativeTab of win.tabs) {
      const mappedCrdtId = chromeToCrdtIdMap.get(nativeTab.id);
      if (mappedCrdtId) {
        if (!currentCrdtTabs[mappedCrdtId]) {
          await chrome.tabs.remove(nativeTab.id);
          chromeToCrdtIdMap.delete(nativeTab.id);
          lastSyncedUrlCache.delete(mappedCrdtId);
        } else {
          activeCrdtTabsCountInWindow++;
          windowsWithRemainingTabs.add(win.id);
        }
      } else {
        activeCrdtTabsCountInWindow++;
        windowsWithRemainingTabs.add(win.id);
      }
    }

    if (activeCrdtTabsCountInWindow === 0) {
      try { await chrome.windows.remove(win.id); } catch (e) {}
    }
  }

  const sortedCrdtTabs = Object.values(currentCrdtTabs).sort((a, b) =>
    a.position.localeCompare(b.position)
  );

  for (const crdtTab of sortedCrdtTabs) {
    const localNativeId = [...chromeToCrdtIdMap.entries()].find(([_, val]) => val === crdtTab.id)?.[0];

    if (!localNativeId) {
      let targetWindowId = windowsWithRemainingTabs.has(Number(crdtTab.windowId)) ? Number(crdtTab.windowId) : undefined;
      const newTab = await chrome.tabs.create({
        windowId: targetWindowId,
        url: crdtTab.url,
        pinned: crdtTab.isPinned,
        active: false
      });
      chromeToCrdtIdMap.set(newTab.id, crdtTab.id);
      lastSyncedUrlCache.set(crdtTab.id, crdtTab.url);
      windowsWithRemainingTabs.add(newTab.windowId);
    } else {
      const nativeTab = await chrome.tabs.get(localNativeId);
      const cachedUrl = lastSyncedUrlCache.get(crdtTab.id);

      if (nativeTab.url !== crdtTab.url) {
        // Isolation Guard Triggered
        if (nativeTab.active && cachedUrl && nativeTab.url !== cachedUrl) {
          const localBranchUuid = crypto.randomUUID();
          chromeToCrdtIdMap.set(localNativeId, localBranchUuid);
          lastSyncedUrlCache.set(localBranchUuid, nativeTab.url);

          doc.transact(() => {
            const forkedTab = new Y.Map();
            forkedTab.set('id', localBranchUuid);
            forkedTab.set('windowId', String(nativeTab.windowId));
            forkedTab.set('url', nativeTab.url);
            forkedTab.set('title', nativeTab.title || 'Cloned Session');
            forkedTab.set('position', generatePositionBetween(crdtTab.position, null));
            forkedTab.set('isPinned', nativeTab.pinned);
            yTabs.set(localBranchUuid, forkedTab);
          });

          const remoteFollowerTab = await chrome.tabs.create({
            windowId: nativeTab.windowId,
            url: crdtTab.url,
            active: false
          });
          chromeToCrdtIdMap.set(remoteFollowerTab.id, crdtTab.id);
          lastSyncedUrlCache.set(crdtTab.id, crdtTab.url);
        } else {
          await chrome.tabs.update(localNativeId, { url: crdtTab.url });
          lastSyncedUrlCache.set(crdtTab.id, crdtTab.url);
        }
      }
    }
  }
}

// -------------------------------------------------------------
// DEBOUNCED CHROMIUM STORAGE SERIALIZER
// -------------------------------------------------------------
doc.on('update', () => {
  if (isApplyingRemoteUpdates) return;
  scheduleDebouncedStorageSync();
});

let syncTimeout = null;
function scheduleDebouncedStorageSync() {
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    const stateUpdateBytes = Y.encodeStateAsUpdate(doc);
    const base64String = btoa(String.fromCharCode(...stateUpdateBytes));
    const chunks = chunkString(base64String, 4000);
    const storagePayload = { _chunkCount: chunks.length };
    
    chunks.forEach((chunk, index) => {
      storagePayload[`tab_sync_v1_chunk_${index}`] = chunk;
    });

    await chrome.storage.sync.set(storagePayload);
  }, 800);
}

function chunkString(str, length) {
  const size = Math.ceil(str.length / length);
  const r = new Array(size);
  for (let i = 0, o = 0; i < size; i++, o += length) {
    r[i] = str.substr(o, length);
  }
  return r;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes._chunkCount) return;
  reassembleAndApplyRemoteState();
});

async function reassembleAndApplyRemoteState() {
  const data = await chrome.storage.sync.get(null);
  const totalChunks = data._chunkCount;
  if (!totalChunks) return;

  let base64String = '';
  for (let i = 0; i < totalChunks; i++) {
    base64String += data[`tab_sync_v1_chunk_${i}`] || '';
  }

  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  isApplyingRemoteUpdates = true;
  try {
    Y.applyUpdate(doc, bytes);
    await reconciliateNativeBrowserUI();
  } catch (err) {
    console.error(err);
  } finally {
    isApplyingRemoteUpdates = false;
  }
}
