const CAPTURE_DELAY_MS = 650;
const CAPTURE_RATE_LIMIT_MS = 550;
const MAX_CANVAS_PIXELS = 120_000_000;
const DEFAULT_FILENAME_SETTINGS = {
  folderName: "full-page-captures",
  source: "title",
  includeNumber: false,
  nextNumber: 1,
  numberPadding: 3,
  includeTimestamp: true
};

let isCapturing = false;

chrome.action.onClicked.addListener(async (tab) => {
  if (isCapturing) {
    await showBadge("BUSY", "#a16207");
    return;
  }

  if (tab.id == null || tab.windowId == null) {
    await showBadge("ERR", "#b91c1c");
    return;
  }

  isCapturing = true;
  await showBadge("0%", "#2563eb");

  try {
    await captureFullPage(tab);
    await showBadge("OK", "#15803d");
  } catch (error) {
    console.error(error);
    await showBadge("ERR", "#b91c1c");
  } finally {
    isCapturing = false;
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  }
});

async function captureFullPage(tab) {
  const metrics = await runInTab(tab.id, collectPageMetrics);

  if (!metrics || metrics.totalHeight <= 0 || metrics.viewportHeight <= 0 || metrics.viewportWidth <= 0) {
    throw new Error("Could not read page dimensions.");
  }

  const yPositions = buildCapturePositions(metrics.totalHeight, metrics.viewportHeight);
  const captures = [];
  let outputScale = 1;
  let outputWidth = metrics.viewportWidth;
  let lastCaptureAt = 0;

  try {
    for (let index = 0; index < yPositions.length; index += 1) {
      const y = yPositions[index];
      await runInTab(tab.id, scrollToCapturePosition, [y]);
      await sleep(CAPTURE_DELAY_MS);

      const waitForRateLimit = Math.max(0, CAPTURE_RATE_LIMIT_MS - (Date.now() - lastCaptureAt));
      if (waitForRateLimit > 0) {
        await sleep(waitForRateLimit);
      }

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      lastCaptureAt = Date.now();

      const blob = await fetch(dataUrl).then((response) => response.blob());
      const bitmap = await createImageBitmap(blob);

      if (index === 0) {
        outputScale = bitmap.width / metrics.viewportWidth;
        outputWidth = bitmap.width;

        const outputHeight = Math.ceil(metrics.totalHeight * outputScale);
        if (outputWidth * outputHeight > MAX_CANVAS_PIXELS) {
          bitmap.close();
          throw new Error("This page is too large to safely stitch in one image.");
        }
      }

      captures.push({ y, bitmap });
      const progress = Math.round(((index + 1) / yPositions.length) * 100);
      await showBadge(`${progress}%`, "#2563eb");
    }

    const outputHeight = Math.ceil(metrics.totalHeight * outputScale);
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext("2d", { alpha: false });

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, outputWidth, outputHeight);

    for (const capture of captures) {
      const destinationY = Math.round(capture.y * outputScale);
      const remainingHeight = outputHeight - destinationY;
      const sourceHeight = Math.min(capture.bitmap.height, remainingHeight);

      if (sourceHeight > 0) {
        context.drawImage(
          capture.bitmap,
          0,
          0,
          capture.bitmap.width,
          sourceHeight,
          0,
          destinationY,
          outputWidth,
          sourceHeight
        );
      }

      capture.bitmap.close();
      capture.bitmap = null;
    }

    const pngBlob = await canvas.convertToBlob({ type: "image/png" });
    const pngDataUrl = await blobToDataUrl(pngBlob);
    const filename = await buildFilename(tab.title, tab.url);

    await chrome.downloads.download({
      url: pngDataUrl,
      filename,
      saveAs: true
    });
  } finally {
    await runInTab(tab.id, restoreOriginalScroll, [metrics.originalScrollX, metrics.originalScrollY]).catch(() => {});

    for (const capture of captures) {
      if (capture.bitmap) {
        capture.bitmap.close();
      }
    }
  }
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return result.result;
}

function collectPageMetrics() {
  const documentElement = document.documentElement;
  const body = document.body;

  return {
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    totalHeight: Math.max(
      documentElement.scrollHeight,
      documentElement.offsetHeight,
      documentElement.clientHeight,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      body ? body.clientHeight : 0
    )
  };
}

function scrollToCapturePosition(y) {
  window.scrollTo(0, y);
}

function restoreOriginalScroll(x, y) {
  window.scrollTo(x, y);
}

function buildCapturePositions(totalHeight, viewportHeight) {
  if (totalHeight <= viewportHeight) {
    return [0];
  }

  const positions = [];
  const maxY = totalHeight - viewportHeight;

  for (let y = 0; y < maxY; y += viewportHeight) {
    positions.push(y);
  }

  if (positions[positions.length - 1] !== maxY) {
    positions.push(maxY);
  }

  return positions;
}

async function buildFilename(title, url) {
  const settings = await getFilenameSettings();
  const parts = [buildFilenameSource(settings.source, title, url)];

  if (settings.includeNumber) {
    parts.push(String(settings.nextNumber).padStart(settings.numberPadding, "0"));
    await saveFilenameSettings({ nextNumber: settings.nextNumber + 1 });
  }

  if (settings.includeTimestamp) {
    parts.push(new Date().toISOString().replace(/[:.]/g, "-"));
  }

  const basename = sanitizeFilenamePart(parts.filter(Boolean).join("-")) || "page";
  const folder = sanitizePathSegment(settings.folderName) || DEFAULT_FILENAME_SETTINGS.folderName;

  return `${folder}/${basename}.png`;
}

async function getFilenameSettings() {
  const saved = await chrome.storage.local.get(DEFAULT_FILENAME_SETTINGS);
  const nextNumber = Number.parseInt(saved.nextNumber, 10);
  const numberPadding = Number.parseInt(saved.numberPadding, 10);

  return {
    folderName: sanitizePathSegment(saved.folderName) || DEFAULT_FILENAME_SETTINGS.folderName,
    source: ["title", "url", "title-url"].includes(saved.source) ? saved.source : DEFAULT_FILENAME_SETTINGS.source,
    includeNumber: Boolean(saved.includeNumber),
    nextNumber: Number.isFinite(nextNumber) && nextNumber > 0 ? nextNumber : DEFAULT_FILENAME_SETTINGS.nextNumber,
    numberPadding: Number.isFinite(numberPadding)
      ? Math.min(Math.max(numberPadding, 1), 8)
      : DEFAULT_FILENAME_SETTINGS.numberPadding,
    includeTimestamp: Boolean(saved.includeTimestamp)
  };
}

async function saveFilenameSettings(settings) {
  await chrome.storage.local.set(settings);
}

function buildFilenameSource(source, title, url) {
  const safeTitle = sanitizeFilenamePart(title);
  const safeUrl = sanitizeFilenamePart(formatUrlForFilename(url));

  if (source === "url") {
    return safeUrl || safeTitle || "page";
  }

  if (source === "title-url") {
    return [safeTitle, safeUrl].filter(Boolean).join("-");
  }

  return safeTitle || safeUrl || "page";
}

function formatUrlForFilename(url) {
  if (!url) {
    return "";
  }

  try {
    const parsedUrl = new URL(url);
    const path = decodeURIComponent(parsedUrl.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "-");

    return [parsedUrl.hostname, path].filter(Boolean).join("-");
  } catch {
    return url;
  }
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function sanitizePathSegment(value) {
  return sanitizeFilenamePart(value).replace(/\.+$/g, "");
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function showBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
