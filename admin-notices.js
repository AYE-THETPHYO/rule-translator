// 管理者画面: 毎日の連絡(朝礼の内容など)を書いて、翻訳を確認して投稿する
const adminTabs = document.getElementById("admin-tabs");
const noticeMain = document.getElementById("notice-main");
const noticeForm = document.getElementById("notice-form");
const noticeFormTitle = document.getElementById("notice-form-title");
const noticeDateInput = document.getElementById("notice-date");
const noticeTitleInput = document.getElementById("notice-title");
const noticeBodyInput = document.getElementById("notice-body");
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

function showNoticeStatus(message, isError = false) {
  noticeStatus.textContent = message;
  noticeStatus.classList.toggle("error", isError);
}

function setNoticeBusy(busy) {
  noticeBusy = busy;
  noticeTranslateBtn.disabled = busy;
  document.getElementById("notice-save").disabled = busy;
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

// ===== 投稿フォーム =====
function resetNoticeForm() {
  noticeForm.reset();
  noticeEditingId = "";
  noticeDraft = null;
  noticeDateInput.value = todayInJapan();
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
  noticeForm.hidden = true;
  noticeReview.hidden = false;
  noticeReviewList.innerHTML = `
    <div class="review-row notice-original">
      <div class="review-ja"><span class="review-num">日</span><strong>${escapeHtml(noticeDraft.title)}</strong></div>
      ${noticeDraft.body ? `<p class="notice-body-text">${escapeHtml(noticeDraft.body)}</p>` : ""}
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
    const notice = { ...noticeDraft, updatedAt: new Date().toISOString() };
    await saveNotice(notice);
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
  noticeList.innerHTML = notices
    .map((notice) => {
      const preview = notice.body.replace(/\s+/g, " ");
      return `
        <article class="manual-card">
          <p class="notice-date-label">${escapeHtml(formatNoticeDate(notice.date))}</p>
          <h4>${escapeHtml(notice.title)}</h4>
          ${preview ? `<p>${escapeHtml(preview.slice(0, 80))}${preview.length > 80 ? "…" : ""}</p>` : ""}
          <div class="meta-row"><span>${Object.keys(notice.translations).length}言語</span></div>
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
    noticeDraft = JSON.parse(JSON.stringify(notice));
    openNoticeReview();
  }

  if (action === "delete") {
    if (!window.confirm(`「${notice.title}」を削除しますか？この操作は元に戻せません。`)) return;
    setNoticeBusy(true);
    try {
      await deleteNotice(notice.id);
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
