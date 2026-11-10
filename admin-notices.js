// 管理者画面: 毎日の連絡(朝礼の内容など)を書いて、翻訳を確認して投稿する
// 写真・ファイルの添付、重要度(通常・重要・緊急)と上部に表示する期限を設定できる
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const PRIORITY_LABELS = { normal: "通常", important: "重要", urgent: "緊急" };

const adminTabs = document.getElementById("admin-tabs");
const noticeMain = document.getElementById("notice-main");
const noticeForm = document.getElementById("notice-form");
const noticeFormTitle = document.getElementById("notice-form-title");
const noticeDateInput = document.getElementById("notice-date");
const noticeTitleInput = document.getElementById("notice-title");
const noticeBodyInput = document.getElementById("notice-body");
const noticePriority = document.getElementById("notice-priority");
const noticePinField = document.getElementById("notice-pin-field");
const noticePinUntil = document.getElementById("notice-pin-until");
const noticeFilesInput = document.getElementById("notice-files");
const noticeAttachmentsEl = document.getElementById("notice-attachments");
const noticeLangChips = document.getElementById("notice-lang-chips");
const noticeLangAdd = document.getElementById("notice-lang-add");
const noticeStatus = document.getElementById("notice-status");
const noticeTranslateBtn = document.getElementById("notice-translate");
const noticeReview = document.getElementById("notice-review");
const noticeReviewList = document.getElementById("notice-review-list");
const noticeList = document.getElementById("notice-list");
const noticeCount = document.getElementById("notice-count");

let notices = [];
let noticeLangs = [];
let noticeEditingId = "";
let noticeDraft = null; // 翻訳後、投稿前の内容
let noticeBusy = false;
let keptAttachments = []; // 編集中の連絡にすでにある添付
let newAttachmentFiles = []; // これからアップロードする添付
let removedAttachmentPaths = [];

function showNoticeStatus(message, isError = false) {
  noticeStatus.textContent = message;
  noticeStatus.classList.toggle("error", isError);
}

function setNoticeBusy(busy) {
  noticeBusy = busy;
  noticeTranslateBtn.disabled = busy;
  document.getElementById("notice-save").disabled = busy;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// ===== タブ切り替え(ルール / 毎日の連絡) =====
function showAdminTab(tab) {
  adminTabs.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  adminMain.hidden = tab !== "rules";
  noticeMain.hidden = tab !== "notices";
  try {
    localStorage.setItem("company-rule-admin-tab", tab);
  } catch {
    /* 無視 */
  }
}

adminTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]")?.dataset.tab;
  if (tab) showAdminTab(tab);
});

// admin.js の管理者画面表示後に呼ばれる
window.onAdminReady = async () => {
  adminTabs.hidden = false;
  let tab = "rules";
  try {
    tab = localStorage.getItem("company-rule-admin-tab") || "rules";
  } catch {
    /* 無視 */
  }
  showAdminTab(tab);
  resetNoticeForm();
  await loadAdminNotices();
};

// ===== 翻訳する言語 =====
function defaultNoticeLangs() {
  const used = new Set(DEFAULT_LANGUAGES);
  rules.forEach((rule) => Object.keys(rule.translations || {}).forEach((lang) => used.add(lang)));
  notices.forEach((notice) => Object.keys(notice.translations || {}).forEach((lang) => used.add(lang)));
  used.delete("ja");
  return [...used].filter((lang) => LANGS[lang]);
}

function renderNoticeLangs() {
  noticeLangChips.innerHTML = noticeLangs
    .map((lang) => `<span class="chip lang-chip">${escapeHtml(LANGS[lang].name)}<button type="button" data-remove-lang="${lang}" aria-label="${escapeHtml(LANGS[lang].name)}を外す">×</button></span>`)
    .join("") || '<span class="muted">翻訳する言語がありません</span>';
  const option = (code) => `<option value="${code}">${escapeHtml(LANGS[code].name)}</option>`;
  const common = COMMON_LANGS.filter((code) => LANGS[code] && !noticeLangs.includes(code));
  const others = Object.keys(LANGS)
    .filter((code) => code !== "ja" && !COMMON_LANGS.includes(code) && !noticeLangs.includes(code))
    .sort((a, b) => LANGS[a].name.localeCompare(LANGS[b].name, "ja"));
  noticeLangAdd.innerHTML = `<option value="">＋ 言語を追加</option>
    <optgroup label="よく使う言語">${common.map(option).join("")}</optgroup>
    <optgroup label="その他の言語">${others.map(option).join("")}</optgroup>`;
}

noticeLangChips.addEventListener("click", (event) => {
  const lang = event.target.dataset.removeLang;
  if (!lang) return;
  noticeLangs = noticeLangs.filter((code) => code !== lang);
  renderNoticeLangs();
});

noticeLangAdd.addEventListener("change", () => {
  if (noticeLangAdd.value) noticeLangs.push(noticeLangAdd.value);
  renderNoticeLangs();
});

// ===== 重要度 =====
function updatePriorityFields() {
  const important = noticePriority.value !== "normal";
  noticePinField.hidden = !important;
  if (important && !noticePinUntil.value) noticePinUntil.value = addDays(noticeDateInput.value || todayInJapan(), 7);
}

noticePriority.addEventListener("change", updatePriorityFields);

// ===== 添付ファイル =====
function renderAttachments() {
  const kept = keptAttachments.map((item, index) => ({ ...item, key: `kept-${index}` }));
  const added = newAttachmentFiles.map((file, index) => ({ name: file.name, type: file.type, size: file.size, key: `new-${index}`, isNew: true }));
  noticeAttachmentsEl.innerHTML = [...kept, ...added]
    .map((item) => `
      <span class="attachment-chip">
        <span aria-hidden="true">${(item.type || "").startsWith("image/") ? "🖼" : "📎"}</span>
        <span class="attachment-name">${escapeHtml(item.name)}</span>
        <small>${formatBytes(item.size || 0)}${item.isNew ? "・未保存" : ""}</small>
        <button type="button" data-remove-attachment="${item.key}" aria-label="${escapeHtml(item.name)}を外す">×</button>
      </span>`)
    .join("");
}

// 大きな写真はスマホで見やすい大きさ(長辺1800px)に縮小して保存する
async function shrinkImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size < 1.5 * 1048576) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

noticeFilesInput.addEventListener("change", async () => {
  const files = [...noticeFilesInput.files];
  noticeFilesInput.value = "";
  const tooBig = [];
  for (const original of files) {
    const file = await shrinkImage(original);
    if (file.size > MAX_ATTACHMENT_BYTES) tooBig.push(original.name);
    else newAttachmentFiles.push(file);
  }
  renderAttachments();
  if (tooBig.length) showNoticeStatus(`20MBを超えるファイルは添付できません: ${tooBig.join("、")}`, true);
});

noticeAttachmentsEl.addEventListener("click", (event) => {
  const key = event.target.dataset.removeAttachment;
  if (!key) return;
  const [kind, index] = key.split("-");
  if (kind === "kept") {
    const [removed] = keptAttachments.splice(Number(index), 1);
    if (removed?.path) removedAttachmentPaths.push(removed.path);
  } else {
    newAttachmentFiles.splice(Number(index), 1);
  }
  renderAttachments();
});

// ===== 投稿フォーム =====
function resetNoticeForm() {
  noticeForm.reset();
  noticeEditingId = "";
  noticeDraft = null;
  keptAttachments = [];
  newAttachmentFiles = [];
  removedAttachmentPaths = [];
  noticeDateInput.value = todayInJapan();
  noticePriority.value = "normal";
  noticePinUntil.value = "";
  updatePriorityFields();
  renderAttachments();
  noticeLangs = defaultNoticeLangs();
  noticeFormTitle.textContent = "今日の連絡を投稿";
  noticeReview.hidden = true;
  noticeForm.hidden = false;
  renderNoticeLangs();
}

document.getElementById("notice-new").addEventListener("click", () => {
  resetNoticeForm();
  showNoticeStatus("");
});

noticeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (noticeBusy) return;
  const title = noticeTitleInput.value.trim();
  const body = noticeBodyInput.value.trim();
  const date = noticeDateInput.value;
  if (!title || !date) {
    showNoticeStatus("日付とタイトルを入力してください。", true);
    return;
  }
  const priority = noticePriority.value;
  const pinnedUntil = priority === "normal" ? "" : noticePinUntil.value || addDays(date, 7);
  const langs = [...noticeLangs];
  const chromeReady = prepareChromeTranslators(langs);
  const previous = notices.find((notice) => notice.id === noticeEditingId);

  setNoticeBusy(true);
  try {
    await chromeReady;
    const translations = {};
    const failed = [];
    for (const [index, lang] of langs.entries()) {
      showNoticeStatus(`翻訳中です… (${index + 1}/${langs.length}: ${LANGS[lang].name})`);
      try {
        translations[lang] = {
          title: await translateText(title, lang),
          body: body ? await translateText(body, lang) : "",
        };
      } catch {
        failed.push(LANGS[lang].name);
      }
    }
    noticeDraft = {
      id: noticeEditingId || createId(),
      date,
      title,
      body,
      priority,
      pinnedUntil,
      translations,
      createdAt: previous?.createdAt || new Date().toISOString(),
    };
    openNoticeReview(failed);
  } finally {
    setNoticeBusy(false);
  }
});

// ===== 翻訳の確認・修正 =====
function openNoticeReview(failed = []) {
  const langs = Object.keys(noticeDraft.translations);
  const attachmentCount = keptAttachments.length + newAttachmentFiles.length;
  noticeForm.hidden = true;
  noticeReview.hidden = false;
  noticeReviewList.innerHTML = `
    <div class="review-row notice-original">
      <div class="review-ja">
        <span class="review-num">日</span>
        <strong>${escapeHtml(noticeDraft.title)}</strong>
        ${noticeDraft.priority !== "normal" ? `<span class="priority-badge priority-${noticeDraft.priority}">${PRIORITY_LABELS[noticeDraft.priority]}</span>` : ""}
      </div>
      ${noticeDraft.body ? `<p class="notice-body-text">${escapeHtml(noticeDraft.body)}</p>` : ""}
      ${attachmentCount ? `<p class="muted">📎 添付 ${attachmentCount}件(投稿時にアップロードされます)</p>` : ""}
    </div>
    ${langs.map((lang) => {
      const dirAttr = RTL_LANGS.has(lang) ? 'dir="rtl"' : "";
      const entry = noticeDraft.translations[lang];
      return `
        <div class="review-row">
          <div class="review-ja"><span class="review-num">${escapeHtml(lang.toUpperCase())}</span>${escapeHtml(LANGS[lang]?.name || lang)}</div>
          <input type="text" data-lang="${lang}" data-field="title" lang="${lang}" ${dirAttr} value="${escapeHtml(entry.title)}" />
          ${noticeDraft.body ? `<textarea data-lang="${lang}" data-field="body" lang="${lang}" ${dirAttr} rows="${Math.min(10, Math.max(3, Math.ceil(entry.body.length / 40)))}">${escapeHtml(entry.body)}</textarea>` : ""}
        </div>`;
    }).join("")}
  `;
  showNoticeStatus(failed.length
    ? `翻訳できなかった言語: ${failed.join("、")}(日本語のまま表示されます)。訳を確認して「この内容で投稿」を押してください。`
    : "翻訳が終わりました。訳を確認・修正して「この内容で投稿」を押してください。", failed.length > 0);
  noticeReview.scrollIntoView({ behavior: "smooth", block: "start" });
}

noticeReviewList.addEventListener("input", (event) => {
  const { lang, field } = event.target.dataset;
  if (!lang || !field || !noticeDraft) return;
  noticeDraft.translations[lang][field] = event.target.value;
});

document.getElementById("notice-cancel").addEventListener("click", () => {
  noticeReview.hidden = true;
  noticeForm.hidden = false;
  showNoticeStatus("投稿を取り消しました。内容を直して、もう一度「翻訳する」を押せます。");
});

document.getElementById("notice-save").addEventListener("click", async () => {
  if (noticeBusy || !noticeDraft) return;
  setNoticeBusy(true);
  try {
    const uploaded = [];
    for (const [index, file] of newAttachmentFiles.entries()) {
      showNoticeStatus(`添付ファイルをアップロードしています… (${index + 1}/${newAttachmentFiles.length})`);
      uploaded.push(await uploadNoticeFile(noticeDraft.id, file));
    }
    const notice = {
      ...noticeDraft,
      attachments: [...keptAttachments, ...uploaded],
      updatedAt: new Date().toISOString(),
    };
    showNoticeStatus("投稿しています…");
    await saveNotice(notice);
    await deleteStoredFiles(removedAttachmentPaths).catch(() => {});
    const wasEditing = Boolean(noticeEditingId);
    notices = [notice, ...notices.filter((item) => item.id !== notice.id)]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    resetNoticeForm();
    renderNoticeList();
    showNoticeStatus(wasEditing ? "連絡を更新しました。" : "連絡を投稿しました。社員のアプリの「お知らせ」に表示されます。");
  } catch (error) {
    showNoticeStatus(error.message, true);
  } finally {
    setNoticeBusy(false);
  }
});

// ===== 投稿済みの連絡 =====
async function loadAdminNotices() {
  try {
    notices = await fetchNotices(200);
    await loadContentAuthors().catch(() => {});
    if (!noticeEditingId) noticeLangs = defaultNoticeLangs();
    renderNoticeLangs();
    renderNoticeList();
  } catch (error) {
    noticeList.innerHTML = `<p class="notice">${escapeHtml(error.message)}</p>`;
  }
}

function formatNoticeDate(date) {
  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString("ja-JP", { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" });
  return date === todayInJapan() ? `今日・${label}` : label;
}

function renderNoticeList() {
  noticeCount.textContent = `${notices.length}件`;
  if (!notices.length) {
    noticeList.innerHTML = '<p class="empty-state">まだ連絡はありません。朝礼の内容などを投稿すると、休みの社員もあとから確認できます。</p>';
    return;
  }
  const today = todayInJapan();
  noticeList.innerHTML = notices
    .map((notice) => {
      const preview = notice.body.replace(/\s+/g, " ");
      const pinned = notice.priority !== "normal" && notice.pinnedUntil && notice.pinnedUntil >= today;
      return `
        <article class="manual-card ${notice.priority !== "normal" ? `card-${notice.priority}` : ""}">
          <p class="notice-date-label">${escapeHtml(formatNoticeDate(notice.date))}</p>
          <h4>
            ${notice.priority !== "normal" ? `<span class="priority-badge priority-${notice.priority}">${PRIORITY_LABELS[notice.priority]}</span>` : ""}
            ${escapeHtml(notice.title)}
          </h4>
          ${preview ? `<p>${escapeHtml(preview.slice(0, 80))}${preview.length > 80 ? "…" : ""}</p>` : ""}
          <div class="meta-row">
            <span>${Object.keys(notice.translations).length}言語</span>
            ${notice.attachments.length ? `<span>📎 ${notice.attachments.length}件</span>` : ""}
            ${notice.priority !== "normal" && notice.pinnedUntil ? `<span>${pinned ? "上部に表示中" : "表示期限切れ"}(〜${escapeHtml(notice.pinnedUntil.slice(5).replace("-", "/"))})</span>` : ""}
          </div>
          ${authorLine("notice", notice.id)}
          <div class="card-actions">
            <button class="small-btn" data-notice-action="edit" data-id="${notice.id}" type="button">編集</button>
            <button class="small-btn" data-notice-action="fix" data-id="${notice.id}" type="button">訳を修正</button>
            <button class="small-btn danger" data-notice-action="delete" data-id="${notice.id}" type="button">削除</button>
          </div>
        </article>`;
    })
    .join("");
}

noticeList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-notice-action]");
  if (!button || noticeBusy) return;
  const notice = notices.find((item) => item.id === button.dataset.id);
  if (!notice) return;
  const action = button.dataset.noticeAction;

  if (action === "edit") {
    resetNoticeForm();
    noticeEditingId = notice.id;
    noticeDateInput.value = notice.date;
    noticeTitleInput.value = notice.title;
    noticeBodyInput.value = notice.body;
    noticePriority.value = notice.priority;
    noticePinUntil.value = notice.pinnedUntil || "";
    updatePriorityFields();
    keptAttachments = [...notice.attachments];
    renderAttachments();
    noticeLangs = Object.keys(notice.translations).filter((lang) => LANGS[lang]);
    if (!noticeLangs.length) noticeLangs = defaultNoticeLangs();
    renderNoticeLangs();
    noticeFormTitle.textContent = `編集中: ${notice.title}`;
    showNoticeStatus("内容を直して「翻訳する」を押してください。訳だけ直す場合は一覧の「訳を修正」を使います。");
    noticeForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (action === "fix") {
    resetNoticeForm();
    noticeEditingId = notice.id;
    keptAttachments = [...notice.attachments];
    noticeDraft = JSON.parse(JSON.stringify(notice));
    openNoticeReview();
  }

  if (action === "delete") {
    if (!window.confirm(`「${notice.title}」を削除しますか？添付ファイルも削除され、元に戻せません。`)) return;
    setNoticeBusy(true);
    try {
      await deleteNotice(notice.id);
      await deleteStoredFiles(notice.attachments.map((item) => item.path)).catch(() => {});
      notices = notices.filter((item) => item.id !== notice.id);
      if (noticeEditingId === notice.id) resetNoticeForm();
      renderNoticeList();
      showNoticeStatus("連絡を削除しました。");
    } catch (error) {
      showNoticeStatus(error.message, true);
    } finally {
      setNoticeBusy(false);
    }
  }
});
