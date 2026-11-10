// 利用者画面: 日ごとのお知らせ(連絡 + その日に追加・更新されたルール)。前回見たあとの新着には NEW を付ける。
const LAST_SEEN_KEY = "company-rule-last-seen-v1";
const VIEW_KEY = "company-rule-user-view-v1";
const userTabs = document.getElementById("user-tabs");
const noticeView = document.getElementById("notice-view");
const noticeFeed = document.getElementById("notice-feed");
const noticeNewCount = document.getElementById("notice-new-count");

let userNotices = [];
let currentView = "notices";
let lastSeen = "";
let seenThisVisit = "";
const showJapanese = new Set();
const liveTranslations = new Map(); // 端末でその場翻訳した結果 `${id}|${lang}`

try {
  lastSeen = localStorage.getItem(LAST_SEEN_KEY) || "";
  currentView = localStorage.getItem(VIEW_KEY) || "notices";
} catch {
  /* 無視 */
}
seenThisVisit = lastSeen;

async function loadNotices() {
  try {
    userNotices = await fetchNotices(90);
  } catch (error) {
    userNotices = [];
    noticeFeed.innerHTML = `<p class="notice">${escapeHtml(error.message)}</p>`;
  }
}

function isNew(timestamp) {
  return Boolean(timestamp) && (!seenThisVisit || timestamp > seenThisVisit);
}

function newItemCount() {
  return userNotices.filter((notice) => isNew(notice.createdAt)).length
    + rules.filter((rule) => isNew(rule.updatedAt)).length;
}

function hideMainViews() {
  userTabs.hidden = true;
  noticeView.hidden = true;
  listView.hidden = true;
}

function showMainView() {
  userTabs.hidden = false;
  userTabs.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === currentView));
  const count = newItemCount();
  noticeNewCount.hidden = !count;
  noticeNewCount.textContent = count;
  if (currentView === "notices") {
    listView.hidden = true;
    noticeView.hidden = false;
    renderNotices();
    markSeen();
  } else {
    noticeView.hidden = true;
    listView.hidden = false;
    renderList();
  }
}

// お知らせを開いたら「ここまで見た」と記録(この表示中は NEW を残す)
function markSeen() {
  try {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  } catch {
    /* 無視 */
  }
}

userTabs.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view;
  if (!view) return;
  currentView = view;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 無視 */
  }
  showMainView();
});

function formatFeedDate(date, lang) {
  const day = new Date(`${date}T00:00:00Z`);
  let label;
  try {
    label = day.toLocaleDateString(lang === "ja" ? "ja-JP" : lang, { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" });
  } catch {
    label = day.toLocaleDateString("ja-JP", { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" });
  }
  const jaLabel = day.toLocaleDateString("ja-JP", { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" });
  return lang === "ja" || label === jaLabel ? jaLabel : `${label}(${jaLabel})`;
}

function noticeText(notice, lang) {
  if (lang === "ja" || showJapanese.has(notice.id)) return { title: notice.title, body: notice.body, translated: lang === "ja" };
  const saved = notice.translations?.[lang];
  if (saved?.title) return { title: saved.title, body: saved.body || "", translated: true };
  const live = liveTranslations.get(`${notice.id}|${lang}`);
  if (live) return { ...live, translated: true };
  return { title: notice.title, body: notice.body, translated: false };
}

function renderNotices() {
  const lang = prefs.lang;
  const today = todayInJapan();
  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { notices: [], rules: [] });
    return days.get(key);
  };
  userNotices.forEach((notice) => dayOf(notice.date).notices.push(notice));
  rules.forEach((rule) => {
    if (rule.updatedAt) dayOf(dateKeyInJapan(rule.updatedAt)).rules.push(rule);
  });
  const keys = [...days.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 60);

  if (!keys.length) {
    noticeFeed.innerHTML = '<p class="empty-state">まだお知らせはありません。</p>';
    return;
  }

  noticeFeed.innerHTML = keys
    .map((key) => {
      const day = days.get(key);
      const items = [
        ...day.notices.map((notice) => {
          const text = noticeText(notice, lang);
          const canToggle = lang !== "ja";
          return `
            <article class="feed-item ${isNew(notice.createdAt) ? "is-new" : ""}">
              <div class="feed-item-head">
                <span class="feed-kind">お知らせ</span>
                ${isNew(notice.createdAt) ? '<span class="new-badge">NEW</span>' : ""}
              </div>
              <h3 lang="${text.translated ? lang : "ja"}">${escapeHtml(text.title)}</h3>
              ${text.body ? `<p class="notice-body-text" lang="${text.translated ? lang : "ja"}">${escapeHtml(text.body)}</p>` : ""}
              ${canToggle && !text.translated && !showJapanese.has(notice.id)
                ? `<button class="small-btn" data-translate-notice="${notice.id}" type="button">${escapeHtml(langLabel(lang))}に翻訳する</button>`
                : ""}
              ${canToggle && (text.translated || showJapanese.has(notice.id))
                ? `<button class="small-btn" data-toggle-ja="${notice.id}" type="button">${showJapanese.has(notice.id) ? "翻訳を表示" : "日本語の原文を見る"}</button>`
                : ""}
            </article>`;
        }),
        ...day.rules.map((rule) => `
          <a class="feed-item feed-rule ${isNew(rule.updatedAt) ? "is-new" : ""}" href="#rule-${encodeURIComponent(rule.id)}">
            <span class="pdf-icon" aria-hidden="true">PDF</span>
            <div>
              <div class="feed-item-head">
                <span class="feed-kind rule-kind">${rule.createdAt && dateKeyInJapan(rule.createdAt) === key ? "新しいルール" : "ルール更新"}</span>
                ${isNew(rule.updatedAt) ? '<span class="new-badge">NEW</span>' : ""}
              </div>
              <h3>${escapeHtml(rule.title)}</h3>
            </div>
          </a>`),
      ];
      return `
        <section class="feed-day">
          <h2 class="feed-date ${key === today ? "is-today" : ""}">${key === today ? '<span class="today-badge">今日</span>' : ""}${escapeHtml(formatFeedDate(key, lang))}</h2>
          ${items.join("")}
        </section>`;
    })
    .join("");
}

noticeFeed.addEventListener("click", async (event) => {
  const toggleId = event.target.dataset.toggleJa;
  if (toggleId) {
    if (showJapanese.has(toggleId)) showJapanese.delete(toggleId);
    else showJapanese.add(toggleId);
    renderNotices();
    return;
  }
  const translateId = event.target.dataset.translateNotice;
  if (!translateId) return;
  const notice = userNotices.find((item) => item.id === translateId);
  if (!notice) return;
  event.target.disabled = true;
  event.target.textContent = "翻訳中…";
  try {
    const lang = prefs.lang;
    liveTranslations.set(`${notice.id}|${lang}`, {
      title: await translateText(notice.title, lang),
      body: notice.body ? await translateText(notice.body, lang) : "",
    });
  } catch {
    event.target.textContent = "翻訳できませんでした";
    return;
  }
  renderNotices();
});
