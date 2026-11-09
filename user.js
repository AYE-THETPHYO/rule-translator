// 利用者画面: 選んだ言語の翻訳PDFだけを表示(未翻訳の言語は開いた時に自動翻訳してPDF化)
const PREF_KEY = "company-rule-user-prefs-v1";

const langSelect = document.getElementById("user-lang");
const searchInput = document.getElementById("user-search");
const listView = document.getElementById("list-view");
const listEl = document.getElementById("user-rule-list");
const detailView = document.getElementById("detail-view");
const detailEl = document.getElementById("user-detail");
const backBtn = document.getElementById("back-btn");

let rules = [];
let prefs = { lang: "" };
let showOriginal = false;
const pendingTranslations = new Map(); // `${ruleId}|${lang}` -> Promise
const failedTranslations = new Map(); // key -> "limit" | "error"

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
  } catch {
    /* 保存領域が使えない場合は既定値 */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* 無視 */
  }
}

function langLabel(code) {
  if (code === "ja") return "日本語";
  const native = nativeLanguageName(code);
  const ja = LANGS[code]?.name || code;
  return native && native !== ja && native !== code ? `${native} (${ja})` : ja;
}

// 全言語を表示。翻訳済みの言語を先頭グループにまとめる
function renderLangOptions() {
  const translated = new Set();
  rules.forEach((rule) => Object.keys(rule.translations || {}).forEach((code) => {
    if (code !== "ja" && LANGS[code]) translated.add(code);
  }));
  const byName = (a, b) => LANGS[a].name.localeCompare(LANGS[b].name, "ja");
  const ready = [...translated].sort(byName);
  const others = Object.keys(LANGS).filter((code) => code !== "ja" && !translated.has(code)).sort(byName);

  if (!prefs.lang || !LANGS[prefs.lang]) prefs.lang = ready[0] || "ja";

  const option = (code) => `<option value="${code}" ${code === prefs.lang ? "selected" : ""}>${escapeHtml(langLabel(code))}</option>`;
  langSelect.innerHTML = `
    ${option("ja")}
    ${ready.length ? `<optgroup label="翻訳済み">${ready.map(option).join("")}</optgroup>` : ""}
    <optgroup label="その他の言語(自動翻訳)">${others.map(option).join("")}</optgroup>
  `;
}

function hasLang(rule, lang) {
  return Boolean(rule.translations?.[lang]);
}

function renderList() {
  if (!rules.length) {
    listEl.innerHTML = '<p class="empty-state">公開されているルールはまだありません。</p>';
    return;
  }
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filtered = rules.filter((rule) => !query || rule.title.toLocaleLowerCase().includes(query));
  if (!filtered.length) {
    listEl.innerHTML = '<p class="empty-state">該当するルールはありません。</p>';
    return;
  }
  listEl.innerHTML = filtered
    .map((rule) => `
      <a class="user-rule-card" href="#rule-${encodeURIComponent(rule.id)}">
        <span class="pdf-icon" aria-hidden="true">PDF</span>
        <div>
          <h2>${escapeHtml(rule.title)}</h2>
          <span class="tag-muted">${hasLang(rule, prefs.lang) ? escapeHtml(langLabel(prefs.lang)) : "開くと自動翻訳します"}</span>
        </div>
      </a>
    `)
    .join("");
}

// 未翻訳の言語をその場で翻訳して保存(PDFは表示時に作成)
function ensureTranslation(rule, lang) {
  const key = `${rule.id}|${lang}`;
  if (pendingTranslations.has(key)) return;
  failedTranslations.delete(key);
  const job = (rule.blocks?.length
    ? translateBlocks(rule.blocks, lang).then((texts) => storeTranslation(rule, lang, texts.join("\n"), texts))
    : translateText(rule.sourceText, lang).then((text) => storeTranslation(rule, lang, text)))
    .then(() => {
      renderLangOptions();
    })
    .catch((error) => {
      failedTranslations.set(key, error.code === "limit" ? "limit" : "error");
    })
    .finally(() => {
      pendingTranslations.delete(key);
      route();
    });
  pendingTranslations.set(key, job);
}

function renderDetail(rule) {
  const lang = prefs.lang;
  const isJa = lang === "ja";
  const key = `${rule.id}|${lang}`;
  const translated = hasLang(rule, lang);

  if (!isJa && !translated && !failedTranslations.has(key)) ensureTranslation(rule, lang);
  const loading = !isJa && !translated && pendingTranslations.has(key);
  const failure = !isJa && !translated ? failedTranslations.get(key) : null;

  // 表示するPDFの言語(翻訳中は表示しない、失敗時は日本語原本)
  let pdfLang = null;
  if (isJa || showOriginal || failure) pdfLang = "ja";
  else if (translated) pdfLang = lang;

  detailEl.innerHTML = `
    <header class="user-detail-head">
      <h1>${escapeHtml(rule.title)}</h1>
      ${pdfLang ? `<p class="muted">${escapeHtml(pdfLang === "ja" ? "日本語(原本)" : `${langLabel(pdfLang)} ・ 自動翻訳`)}</p>` : ""}
    </header>
    ${loading ? `<p class="notice loading">${escapeHtml(langLabel(lang))} に翻訳してPDFを作成しています…</p>` : ""}
    ${failure ? `
      <p class="notice">${failure === "limit"
        ? "翻訳サービスの利用上限に達したため、今は翻訳できません。しばらくしてから再度お試しください。日本語の原本PDFを表示しています。"
        : "この言語には翻訳できませんでした。日本語の原本PDFを表示しています。"}</p>
      <button id="retry-translation" class="secondary-btn" type="button">もう一度翻訳する</button>
    ` : ""}
    ${pdfLang ? `
      <div class="pdf-actions">
        ${!isJa && translated ? `<button id="toggle-original" class="secondary-btn" type="button">${showOriginal ? `${escapeHtml(langLabel(lang))} のPDFに戻る` : "日本語の原本PDFを見る"}</button>` : ""}
        <button id="download-pdf" class="primary-btn" type="button">PDFをダウンロード</button>
      </div>
      <div id="user-pdf" class="pdf-viewer"></div>
    ` : ""}
  `;

  document.getElementById("toggle-original")?.addEventListener("click", () => {
    showOriginal = !showOriginal;
    renderDetail(rule);
  });
  document.getElementById("retry-translation")?.addEventListener("click", () => {
    failedTranslations.delete(key);
    renderDetail(rule);
  });

  if (!pdfLang) return;
  const container = document.getElementById("user-pdf");
  const pdfPromise = getRulePdf(rule, pdfLang);
  document.getElementById("download-pdf").addEventListener("click", async () => {
    const blob = await pdfPromise.catch(() => null);
    if (blob) downloadBlob(blob, pdfFileName(rule, pdfLang));
  });
  pdfPromise
    .then((blob) => (blob ? renderPdfInto(container, blob) : (container.innerHTML = '<p class="notice">PDFがありません。</p>')))
    .catch((error) => { container.innerHTML = `<p class="notice">PDFを表示できませんでした: ${escapeHtml(error.message)}</p>`; });
}

function route() {
  const match = window.location.hash.match(/^#rule-(.+)$/);
  const rule = match ? rules.find((item) => item.id === decodeURIComponent(match[1])) : null;
  if (rule) {
    const wasHidden = detailView.hidden;
    listView.hidden = true;
    detailView.hidden = false;
    renderDetail(rule);
    if (wasHidden) window.scrollTo(0, 0);
    return;
  }
  if (match) {
    listView.hidden = true;
    detailView.hidden = false;
    detailEl.innerHTML = '<p class="notice">このルールは見つかりませんでした。削除されたか、この端末にはまだ登録されていません。</p>';
    return;
  }
  detailView.hidden = true;
  listView.hidden = false;
  showOriginal = false;
  renderList();
}

async function refresh() {
  try {
    rules = await fetchRules();
  } catch (error) {
    listEl.innerHTML = `<p class="notice">${escapeHtml(error.message)} 通信環境を確認して、ページを再読み込みしてください。</p>`;
    return;
  }
  renderLangOptions();
  route();
}

langSelect.addEventListener("change", () => {
  prefs.lang = langSelect.value;
  showOriginal = false;
  savePrefs();
  route();
});
searchInput.addEventListener("input", renderList);
backBtn.addEventListener("click", () => {
  window.location.hash = "";
});
window.addEventListener("hashchange", () => {
  showOriginal = false;
  route();
});

window.addEventListener("DOMContentLoaded", () => {
  loadPrefs();
  refresh();
});
