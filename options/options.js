const DEFAULT_SETTINGS = {
  folderName: "full-page-captures",
  source: "title",
  includeNumber: false,
  nextNumber: 1,
  numberPadding: 3,
  includeTimestamp: true
};

const form = document.querySelector("#settings-form");
const statusElement = document.querySelector("#status");
const previewElement = document.querySelector("#filename-preview");
const resetButton = document.querySelector("#reset-button");

const fields = {
  folderName: document.querySelector("#folderName"),
  source: document.querySelector("#source"),
  includeNumber: document.querySelector("#includeNumber"),
  nextNumber: document.querySelector("#nextNumber"),
  numberPadding: document.querySelector("#numberPadding"),
  includeTimestamp: document.querySelector("#includeTimestamp")
};

restoreSettings();

form.addEventListener("input", () => {
  updatePreview(readFormSettings());
  clearStatus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set(readFormSettings());
  showStatus("保存しました");
});

resetButton.addEventListener("click", async () => {
  applySettings(DEFAULT_SETTINGS);
  await chrome.storage.local.set(DEFAULT_SETTINGS);
  showStatus("初期設定に戻しました");
});

async function restoreSettings() {
  const savedSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = normalizeSettings(savedSettings);
  applySettings(settings);
}

function applySettings(settings) {
  fields.folderName.value = settings.folderName;
  fields.source.value = settings.source;
  fields.includeNumber.checked = settings.includeNumber;
  fields.nextNumber.value = settings.nextNumber;
  fields.numberPadding.value = settings.numberPadding;
  fields.includeTimestamp.checked = settings.includeTimestamp;
  updatePreview(settings);
}

function readFormSettings() {
  return normalizeSettings({
    folderName: fields.folderName.value,
    source: fields.source.value,
    includeNumber: fields.includeNumber.checked,
    nextNumber: fields.nextNumber.value,
    numberPadding: fields.numberPadding.value,
    includeTimestamp: fields.includeTimestamp.checked
  });
}

function normalizeSettings(settings) {
  const nextNumber = Number.parseInt(settings.nextNumber, 10);
  const numberPadding = Number.parseInt(settings.numberPadding, 10);

  return {
    folderName: sanitizePathSegment(settings.folderName) || DEFAULT_SETTINGS.folderName,
    source: ["title", "url", "title-url"].includes(settings.source) ? settings.source : DEFAULT_SETTINGS.source,
    includeNumber: Boolean(settings.includeNumber),
    nextNumber: Number.isFinite(nextNumber) && nextNumber > 0 ? nextNumber : DEFAULT_SETTINGS.nextNumber,
    numberPadding: Number.isFinite(numberPadding)
      ? Math.min(Math.max(numberPadding, 1), 8)
      : DEFAULT_SETTINGS.numberPadding,
    includeTimestamp: Boolean(settings.includeTimestamp)
  };
}

function updatePreview(settings) {
  const exampleTitle = "Example Page Title";
  const exampleUrl = "https://example.com/articles/full-page-capture";
  const parts = [buildFilenameSource(settings.source, exampleTitle, exampleUrl)];

  if (settings.includeNumber) {
    parts.push(String(settings.nextNumber).padStart(settings.numberPadding, "0"));
  }

  if (settings.includeTimestamp) {
    parts.push("2026-08-30T10-30-00-000Z");
  }

  previewElement.textContent = `${settings.folderName}/${sanitizeFilenamePart(parts.join("-"))}.png`;
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

function showStatus(message) {
  statusElement.textContent = message;
  window.setTimeout(clearStatus, 2400);
}

function clearStatus() {
  statusElement.textContent = "";
}
