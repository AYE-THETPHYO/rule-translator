// 管理者画面: 日本語ファイル(PDF・スライド・画像)をアップロード → 日本語を読み取り → 各言語に翻訳 → 翻訳PDFを作成
const DEFAULT_LANGUAGES = new Set(["my", "vi", "ne"]);
const MANY_LANGUAGES = 15;
const OCR_MIN_CONFIDENCE = 60;

const ruleForm = document.getElementById("rule-form");
const ruleList = document.getElementById("rule-list");
const ruleSearch = document.getElementById("rule-search");
const viewerCard = document.getElementById("viewer-card");
const countBadge = document.getElementById("count-badge");
const resetFormBtn = document.getElementById("reset-form");
const exportSelectedBtn = document.getElementById("export-selected");
const statusMessage = document.getElementById("status-message");
const titleInput = document.getElementById("title");
const japaneseTextInput = document.getElementById("japaneseText");
const pdfUploadInput = document.getElementById("pdfUpload");
const languageOptions = document.getElementById("language-options");
const languageSearch = document.getElementById("language-search");
const submitBtn = document.getElementById("submit-btn");
const formTitle = document.getElementById("form-title");
const openUserView = document.getElementById("open-user-view");
const statRules = document.getElementById("stat-rules");
const statLangs = document.getElementById("stat-langs");
const selectedCount = document.getElementById("selected-count");
const blocksSection = document.getElementById("blocks-section");
const blocksList = document.getElementById("blocks-list");
const blocksCount = document.getElementById("blocks-count");
const textSection = document.getElementById("text-section");
const engineNote = document.getElementById("engine-note");

let rules = [];
let selectedId = "";
let editingId = "";
let selectedLang = "ja";
let isBusy = false;
let currentFile = null; // 今回アップロードしたファイル
let currentPages = null; // そのページ画像
let currentBlocks = []; // 読み取った日本語ブロック
let ocrWorkerPromise = null;

function createId() {
  return window.crypto?.randomUUID?.() || `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

async function loadRules() {
  rules = await fetchRules();
  if (!getRuleById(selectedId)) selectedId = rules[0]?.id || "";
}

function getRuleById(id) {
  return rules.find((rule) => rule.id === id);
}

function selectedMode() {
  return ruleForm.querySelector('input[name="outputMode"]:checked')?.value || "layout";
}

function setMode(mode) {
  const radio = ruleForm.querySelector(`input[name="outputMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

// ===== 翻訳先言語の選択 =====
function renderLanguageOptions(checked = DEFAULT_LANGUAGES) {
  languageOptions.innerHTML = Object.entries(LANGS)
    .filter(([code]) => code !== "ja")
    .sort(([, first], [, second]) => first.name.localeCompare(second.name, "ja"))
    .map(([code, info]) => `
      <label class="language-option" data-search="${escapeHtml(`${info.name} ${code}`.toLocaleLowerCase("ja"))}">
        <input type="checkbox" value="${code}" ${checked.has(code) ? "checked" : ""} />
        ${escapeHtml(info.label)}
      </label>
    `)
    .join("");
  applyLanguageFilter();
  updateSelectedCount();
}

function checkedLanguages() {
  return Array.from(languageOptions.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
}

function updateSelectedCount() {
  const total = languageOptions.querySelectorAll('input[type="checkbox"]').length;
  selectedCount.textContent = `${checkedLanguages().length} / ${total} 言語を選択中`;
}

function setLanguagesChecked(checked, onlyVisible = false) {
  languageOptions.querySelectorAll(".language-option").forEach((option) => {
    if (onlyVisible && option.hidden) return;
    option.querySelector("input").checked = checked;
  });
  updateSelectedCount();
}

function applyLanguageFilter() {
  const query = languageSearch.value.trim().toLocaleLowerCase("ja");
  languageOptions.querySelectorAll(".language-option").forEach((option) => {
    option.hidden = !option.dataset.search.includes(query);
  });
}

function renderEngineNote() {
  engineNote.textContent = (hasChromeTranslator() ? "Chrome内蔵翻訳と、" : "")
    + "このPCで動く翻訳AI(200言語・無料・上限なし)で翻訳します。初回だけ翻訳AIのダウンロード(数百MB)に数分かかります。"
    + "翻訳できなかった言語は「未翻訳」として保存され、あとで「翻訳をやり直す」で翻訳できます。";
}

// クリック直後に呼ぶ(Chromeの翻訳モデルのダウンロードにはユーザー操作が必要なため)
function prepareChromeTranslators(langs) {
  if (!hasChromeTranslator()) return Promise.resolve();
  return Promise.allSettled(langs.filter((lang) => !chromeTranslators.has(lang)).map((lang) =>
    withTimeout(self.Translator.create({ sourceLanguage: "ja", targetLanguage: lang }), 20000)
      .then((translator) => chromeTranslators.set(lang, translator))
      .catch(() => chromeUnavailable.add(lang))));
}

// ===== ファイル読み取り(PDFの文字 / 画像はOCR) =====
function getOcrWorker() {
  if (!window.Tesseract) throw new Error("文字認識(OCR)ライブラリを読み込めませんでした。");
  if (!ocrWorkerPromise) {
    // PSM 11(まばらなテキスト): ポスターやスライドのように文字が散らばっている画像向け
    ocrWorkerPromise = window.Tesseract.createWorker("jpn").then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      return worker;
    });
  }
  return ocrWorkerPromise;
}

// 日本語らしさ(ひらがな・カタカナ・漢字の割合)
function japaneseRatio(text) {
  const chars = Array.from(text.replace(/\s/g, ""));
  if (!chars.length) return 0;
  return chars.filter((char) => /[\u3001-\u30ff\u3400-\u9fff]/.test(char)).length / chars.length;
}

// 1行の中で単語の間が大きく空いていたら別の段として分ける(2段組みのポスター・スライド対策)
function splitLineByGaps(line) {
  const words = (line.words || []).filter((word) => word.text.trim());
  if (!words.length) return [line];
  const height = line.bbox.y1 - line.bbox.y0;
  const groups = [[words[0]]];
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].bbox.x0 - words[index - 1].bbox.x1;
    if (gap > height * 1.2) groups.push([]);
    groups[groups.length - 1].push(words[index]);
  }
  return groups.map((group) => ({
    text: group.map((word) => word.text).join(" "),
    confidence: group.reduce((sum, word) => sum + word.confidence, 0) / group.length,
    bbox: {
      x0: Math.min(...group.map((word) => word.bbox.x0)),
      y0: Math.min(...group.map((word) => word.bbox.y0)),
      x1: Math.max(...group.map((word) => word.bbox.x1)),
      y1: Math.max(...group.map((word) => word.bbox.y1)),
    },
  }));
}

async function ocrPage(canvas, pageIndex) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);
  const lines = (data.lines || [])
    .filter((line) => line.confidence >= OCR_MIN_CONFIDENCE)
    .flatMap(splitLineByGaps)
    .map((line) => ({
      x0: line.bbox.x0,
      y0: line.bbox.y0,
      x1: line.bbox.x1,
      y1: line.bbox.y1,
      h: line.bbox.y1 - line.bbox.y0,
      text: cleanOcrText(line.text),
    }))
    .filter((line) => line.text.replace(/\s/g, "").length >= 3 && japaneseRatio(line.text) >= 0.6);
  return groupLinesIntoBlocks(lines, pageIndex);
}

async function readFile(file) {
  showStatus("ファイルを読み込み中です…");
  const pages = await renderSourcePages(file);
  const blocks = [];
  for (const [index, page] of pages.entries()) {
    let pageBlocks = groupLinesIntoBlocks(groupItemsIntoLines(page.items), index);
    if (!pageBlocks.length) {
      showStatus(`画像から日本語を読み取っています(OCR)… ${index + 1}/${pages.length}ページ${ocrWorkerPromise ? "" : " ※初回は準備に少し時間がかかります"}`);
      pageBlocks = await ocrPage(page.canvas, index);
    }
    blocks.push(...pageBlocks);
  }
  return { pages, blocks };
}

async function handleFileSelected(file) {
  if (!file) return;
  setBusy(true);
  try {
    const { pages, blocks } = await readFile(file);
    currentFile = file;
    currentPages = pages;
    currentBlocks = blocks;
    japaneseTextInput.value = blocks.map((block) => block.text).join("\n");
    if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, "");
    renderBlocks();
    if (blocks.length) {
      showStatus(`${file.name}(${pages.length}ページ)から日本語を${blocks.length}か所読み取りました。内容を確認して保存してください。`);
    } else {
      setMode("text");
      showStatus("日本語の文字を読み取れませんでした。本文を入力すると、テキストのみの翻訳PDFを作成できます。", true);
    }
  } catch (error) {
    currentFile = null;
    currentPages = null;
    currentBlocks = [];
    renderBlocks();
    showStatus(`ファイルの読み取りに失敗しました: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

// ===== 読み取った日本語の確認・修正 =====
function renderBlocks() {
  const hasBlocks = currentBlocks.length > 0;
  blocksSection.hidden = !hasBlocks;
  textSection.hidden = hasBlocks;
  blocksCount.textContent = `${currentBlocks.length}か所`;
  const pageCount = new Set(currentBlocks.map((block) => block.page)).size;
  blocksList.innerHTML = currentBlocks
    .map((block, index) => `
      <div class="block-row">
        ${pageCount > 1 || block.page > 0 ? `<span class="block-page">${block.page + 1}p</span>` : ""}
        <textarea data-index="${index}" rows="${Math.min(4, Math.max(1, Math.ceil(block.text.length / 28)))}">${escapeHtml(block.text)}</textarea>
        <button class="small-btn danger" data-remove="${index}" type="button">除外</button>
      </div>
    `)
    .join("");
}

blocksList.addEventListener("input", (event) => {
  const index = event.target.dataset.index;
  if (index !== undefined) currentBlocks[Number(index)].text = event.target.value;
});

blocksList.addEventListener("click", (event) => {
  const index = event.target.dataset.remove;
  if (index === undefined) return;
  currentBlocks.splice(Number(index), 1);
  renderBlocks();
});

// ===== フォーム =====
function resetForm() {
  ruleForm.reset();
  japaneseTextInput.value = "";
  pdfUploadInput.value = "";
  editingId = "";
  currentFile = null;
  currentPages = null;
  currentBlocks = [];
  setMode("layout");
  renderBlocks();
  renderLanguageOptions();
  formTitle.textContent = "会社ルール翻訳フォーム";
  submitBtn.textContent = "翻訳して保存";
}

function populateForm(rule) {
  resetForm();
  titleInput.value = rule.title;
  japaneseTextInput.value = rule.sourceText;
  editingId = rule.id;
  currentBlocks = (rule.blocks || []).map((block) => ({ ...block }));
  setMode(rule.mode || "text");
  renderBlocks();
  const existing = new Set(Object.keys(rule.translations).filter((key) => key !== "ja"));
  renderLanguageOptions(existing.size ? existing : DEFAULT_LANGUAGES);
  formTitle.textContent = `編集中: ${rule.title}`;
  submitBtn.textContent = "更新して保存";
  showStatus("");
  titleInput.focus();
}

function setBusy(busy) {
  isBusy = busy;
  submitBtn.disabled = busy;
  pdfUploadInput.disabled = busy;
}

// ===== 一覧・プレビュー =====
function renderStats() {
  statRules.textContent = rules.length;
  const langs = new Set(rules.flatMap((rule) => Object.keys(rule.translations).filter((key) => key !== "ja")));
  statLangs.textContent = langs.size;
}

function renderList() {
  countBadge.textContent = `${rules.length}件`;
  if (!rules.length) {
    ruleList.innerHTML = '<p class="empty-state">まだ会社ルールは登録されていません。</p>';
    return;
  }

  const query = ruleSearch.value.trim().toLocaleLowerCase("ja");
  const filtered = rules.filter((rule) => !query || `${rule.title} ${rule.sourceText}`.toLocaleLowerCase("ja").includes(query));
  if (!filtered.length) {
    ruleList.innerHTML = '<p class="empty-state">該当するルールはありません。</p>';
    return;
  }

  ruleList.innerHTML = filtered
    .map((rule) => {
      const isSelected = rule.id === selectedId;
      const flat = rule.sourceText.replace(/\s+/g, " ");
      const preview = `${flat.slice(0, 54)}${flat.length > 54 ? "…" : ""}`;
      const langCount = Object.keys(rule.translations).filter((key) => key !== "ja").length;
      const updated = formatDate(rule.updatedAt);
      return `
        <article class="manual-card ${isSelected ? "active" : ""}">
          <h4>${escapeHtml(rule.title)}</h4>
          <p>${escapeHtml(preview)}</p>
          <div class="meta-row">
            <span>翻訳PDF ${langCount}言語</span>
            ${rule.pendingLangs?.length ? `<span class="pending-tag">未翻訳: ${escapeHtml(rule.pendingLangs.map((lang) => LANGS[lang]?.name || lang).join("、"))}</span>` : ""}
            <span>${rule.mode === "layout" ? "レイアウト維持" : "テキストのみ"}</span>
            <span>${escapeHtml(rule.pdfName || "PDF")}</span>
            ${updated ? `<span>更新: ${updated}</span>` : ""}
          </div>
          <div class="card-actions">
            <button class="small-btn" data-action="select" data-id="${rule.id}" type="button">閲覧</button>
            <button class="small-btn" data-action="edit" data-id="${rule.id}" type="button">編集</button>
            ${rule.pendingLangs?.length ? `<button class="small-btn" data-action="retry" data-id="${rule.id}" type="button">翻訳をやり直す</button>` : ""}
            <button class="small-btn danger" data-action="delete" data-id="${rule.id}" type="button">削除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderViewer() {
  const rule = getRuleById(selectedId);
  if (!rule) {
    openUserView.href = "user.html";
    viewerCard.innerHTML = '<p class="empty-state">左の一覧からルールを選択してください。</p>';
    return;
  }

  openUserView.href = userUrlFor(rule.id);
  if (!rule.translations[selectedLang]) selectedLang = "ja";
  const availableLangs = Object.keys(rule.translations).filter((code) => LANGS[code]);

  viewerCard.innerHTML = `
    <div class="viewer-header">
      <div>
        <h3>${escapeHtml(rule.title)}</h3>
        <p>${escapeHtml(rule.pdfName || "翻訳済みルール")}</p>
      </div>
      <span class="badge">${availableLangs.length - 1}言語</span>
    </div>
    <div class="language-switcher">
      ${availableLangs
        .map((key) => `<button class="small-btn ${selectedLang === key ? "active" : ""}" data-lang="${key}" type="button">${escapeHtml(key === "ja" ? "日本語(原本)" : LANGS[key].label)}</button>`)
        .join("")}
    </div>
    <div id="admin-pdf" class="pdf-viewer"></div>
    <div class="qr-card">
      <div>
        <h4>閲覧QRコード</h4>
        <p>現場に掲示すると、利用者がスマートフォンでこのルールの翻訳PDFを開けます。</p>
      </div>
      <img src="${qrImageUrl(rule.id)}" alt="${escapeHtml(rule.title)}のQRコード" />
    </div>
  `;

  viewerCard.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedLang = button.getAttribute("data-lang");
      renderViewer();
    });
  });

  const container = document.getElementById("admin-pdf");
  getRulePdf(rule, selectedLang)
    .then((blob) => (blob ? renderPdfInto(container, blob) : (container.innerHTML = '<p class="empty-state">PDFがありません。</p>')))
    .catch((error) => { container.innerHTML = `<p class="notice">PDFを表示できませんでした: ${escapeHtml(error.message)}</p>`; });
}

async function downloadSelectedPdf() {
  const rule = getRuleById(selectedId);
  if (!rule) return;
  try {
    const blob = await getRulePdf(rule, selectedLang);
    if (blob) downloadBlob(blob, pdfFileName(rule, selectedLang));
  } catch (error) {
    showStatus(`PDFを出力できませんでした: ${error.message}`, true);
  }
}

// ===== 翻訳・PDF作成(保存と再翻訳で共通) =====
async function translatePayload(rule, langs) {
  const failed = [];
  for (const [index, lang] of langs.entries()) {
    showStatus(`翻訳中です… (${index + 1}/${langs.length}: ${LANGS[lang].name})`);
    try {
      if (rule.blocks.length) {
        const texts = await translateBlocks(rule.blocks, lang);
        rule.blockTranslations[lang] = texts;
        rule.translations[lang] = texts.join("\n");
      } else {
        rule.translations[lang] = await translateText(rule.sourceText, lang);
      }
    } catch {
      failed.push(lang);
    }
  }
  return failed;
}

async function buildTranslatedPdfs(rule, pages, langs) {
  for (const [index, lang] of langs.entries()) {
    showStatus(`翻訳PDFを作成中です… (${index + 1}/${langs.length}: ${LANGS[lang].name})`);
    const blob = rule.mode === "layout"
      ? await createOverlayPdf(pages.map((page) => page.canvas), rule.blocks, rule.blockTranslations[lang], lang)
      : await createTextPdf({ title: rule.title, text: rule.translations[lang], lang });
    await savePdf(rule.id, lang, blob);
  }
}

function pendingMessage(langs) {
  const names = langs.slice(0, 10).map((lang) => LANGS[lang]?.name || lang).join("、");
  return `翻訳できなかった言語(${langs.length}件): ${names}${langs.length > 10 ? " ほか" : ""}。日本語の原本と翻訳できた言語は保存済みです。一覧の「翻訳をやり直す」で、あとから翻訳できます。`;
}

async function retryTranslation(rule) {
  if (isBusy) return;
  const langs = [...(rule.pendingLangs || [])];
  const chromeReady = prepareChromeTranslators(langs);
  setBusy(true);
  try {
    await chromeReady;
    const updated = JSON.parse(JSON.stringify(rule));
    const failed = await translatePayload(updated, langs);
    const done = langs.filter((lang) => !failed.includes(lang));
    if (!done.length) {
      showStatus(`今回も翻訳できませんでした。${pendingMessage(failed)}`, true);
      return;
    }
    let pages = null;
    if (updated.mode === "layout") {
      const source = await loadPdf(rule.id, "src", rule.updatedAt);
      if (!source) throw new Error("元のファイルが見つかりません。");
      pages = await renderSourcePages(source);
    }
    await buildTranslatedPdfs(updated, pages, done);
    updated.pendingLangs = failed;
    updated.updatedAt = new Date().toISOString();
    showStatus("保存しています…");
    await saveRule(updated);
    rules = rules.map((item) => (item.id === updated.id ? updated : item));
    selectedId = updated.id;
    selectedLang = done[0];
    render();
    showStatus(failed.length ? `${done.length}言語を翻訳しました。${pendingMessage(failed)}` : `${done.length}言語を翻訳して保存しました。`, failed.length > 0);
  } catch (error) {
    showStatus(`再翻訳に失敗しました: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

// ===== 保存 =====
ruleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isBusy) return;

  const title = titleInput.value.trim();
  const selectedLanguages = checkedLanguages();
  const chromeReady = prepareChromeTranslators(selectedLanguages);

  if (!editingId && !currentFile) {
    showStatus("新規追加時は日本語のファイル(PDF・画像)をアップロードしてください。", true);
    return;
  }

  const blocks = currentBlocks
    .map((block) => ({ ...block, text: block.text.trim() }))
    .filter((block) => block.text);
  const sourceText = blocks.length ? blocks.map((block) => block.text).join("\n") : japaneseTextInput.value.trim();
  if (!title || !sourceText) {
    showStatus("ルール名と日本語の本文を確認してください。", true);
    return;
  }

  if (selectedLanguages.length > MANY_LANGUAGES && !window.confirm(
    `${selectedLanguages.length}言語に翻訳します。時間がかかり、無料翻訳サービスの1日の上限に達する場合があります。続けますか？`,
  )) return;

  const wasEditing = Boolean(editingId);
  const previous = wasEditing ? getRuleById(editingId) : null;
  const ruleId = editingId || createId();

  setBusy(true);
  try {
    // 元ファイルのページ画像(編集時に新しいファイルがなければ保存済みの元ファイルを使う)
    let pages = currentPages;
    if (!pages && blocks.length) {
      const source = await loadPdf(ruleId, "src", previous?.updatedAt).catch(() => null);
      if (source) pages = await renderSourcePages(source);
    }
    const mode = blocks.length && pages ? selectedMode() : "text";

    const payload = {
      id: ruleId,
      title,
      mode,
      sourceText,
      blocks: blocks.map(({ page, x0, y0, x1, y1, lineHeight, text }) => ({ page, x0, y0, x1, y1, lineHeight, text })),
      translations: { ja: sourceText },
      blockTranslations: {},
      pdfName: currentFile ? currentFile.name : previous?.pdfName || "",
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 翻訳(失敗した言語は「未翻訳」として保存し、あとで再翻訳できる)
    showStatus("翻訳の準備をしています…");
    await chromeReady;
    const failedLangs = await translatePayload(payload, selectedLanguages);
    payload.pendingLangs = failedLangs;

    // 翻訳PDFを作成
    await deleteRulePdfs(ruleId, currentFile ? [] : ["src", "ja"]);
    if (currentFile) {
      await savePdf(ruleId, "src", currentFile);
      const isPdf = currentFile.type === "application/pdf";
      const original = isPdf ? currentFile : await createOverlayPdf(pages.map((page) => page.canvas), [], null, "ja");
      await savePdf(ruleId, "ja", original);
    }
    const pdfLangs = Object.keys(payload.translations).filter((lang) => lang !== "ja");
    await buildTranslatedPdfs(payload, pages, pdfLangs);

    showStatus("保存しています…");
    await saveRule(payload);
    if (wasEditing) {
      rules = rules.map((rule) => (rule.id === ruleId ? payload : rule));
    } else {
      rules.unshift(payload);
    }
    selectedId = ruleId;
    selectedLang = pdfLangs[0] || "ja";
    resetForm();
    render();

    const doneMessage = wasEditing ? "ルールと翻訳PDFを更新しました。" : "翻訳PDFを作成して保存しました。";
    showStatus(failedLangs.length ? `${doneMessage} ${pendingMessage(failedLangs)}` : doneMessage, failedLangs.length > 0);
  } catch (error) {
    showStatus(`保存に失敗しました: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

ruleList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = button.getAttribute("data-id");
  const action = button.getAttribute("data-action");
  const rule = getRuleById(id);

  if (action === "select") {
    selectedId = id;
    render();
  }

  if (action === "edit" && rule) {
    selectedId = id;
    populateForm(rule);
    render();
  }

  if (action === "retry" && rule) {
    retryTranslation(rule);
  }

  if (action === "delete" && rule) {
    if (!window.confirm(`「${rule.title}」とその翻訳PDFを削除しますか？この操作は元に戻せません。`)) return;
    try {
      await deleteRule(id);
      await deleteRulePdfs(id).catch(() => {});
    } catch (error) {
      showStatus(error.message, true);
      return;
    }
    rules = rules.filter((item) => item.id !== id);
    if (selectedId === id) selectedId = rules[0]?.id || "";
    if (editingId === id) resetForm();
    render();
    showStatus("ルールを削除しました。");
  }
});

resetFormBtn.addEventListener("click", () => {
  resetForm();
  showStatus("");
});
exportSelectedBtn.addEventListener("click", downloadSelectedPdf);
pdfUploadInput.addEventListener("change", (event) => handleFileSelected(event.target.files[0]));
languageSearch.addEventListener("input", applyLanguageFilter);
languageOptions.addEventListener("change", updateSelectedCount);
document.getElementById("select-all-langs").addEventListener("click", () => setLanguagesChecked(true));
document.getElementById("select-visible-langs").addEventListener("click", () => setLanguagesChecked(true, true));
document.getElementById("clear-langs").addEventListener("click", () => setLanguagesChecked(false));
ruleSearch.addEventListener("input", renderList);


function render() {
  renderStats();
  renderList();
  renderViewer();
}

// ===== 管理者ログイン =====
const loginPanel = document.getElementById("login-panel");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const signupBtn = document.getElementById("signup-btn");
const logoutBtn = document.getElementById("logout-btn");
const adminMain = document.getElementById("admin-main");
const adminUser = document.getElementById("admin-user");

function showLogin(message = "", isError = false) {
  adminMain.hidden = true;
  loginPanel.hidden = false;
  logoutBtn.hidden = true;
  adminUser.textContent = "";
  loginMessage.textContent = message;
  loginMessage.classList.toggle("error", isError);
}

// ログインを必須に戻すときは true にする(Supabase側のアクセス設定も管理者のみに戻すこと)
const REQUIRE_LOGIN = false;

async function startAdmin() {
  if (!REQUIRE_LOGIN) {
    loginPanel.hidden = true;
    adminMain.hidden = false;
    logoutBtn.hidden = true;
    try {
      await loadRules();
    } catch (error) {
      showStatus(error.message, true);
    }
    resetForm();
    render();
    return;
  }
  const { data } = await db.auth.getSession();
  const session = data.session;
  if (!session) {
    showLogin();
    return;
  }
  logoutBtn.hidden = false;
  if (!(await checkIsAdmin())) {
    showLogin(`${session.user.email} には管理者権限がありません。システム担当者に管理者登録を依頼してください。`, true);
    logoutBtn.hidden = false;
    return;
  }
  loginPanel.hidden = true;
  adminMain.hidden = false;
  adminUser.textContent = session.user.email;
  try {
    await loadRules();
  } catch (error) {
    showStatus(error.message, true);
  }
  resetForm();
  render();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  loginMessage.textContent = "ログインしています…";
  loginMessage.classList.remove("error");
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    showLogin(authErrorMessage(error), true);
    return;
  }
  await startAdmin();
});

signupBtn.addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) {
    showLogin("メールアドレスとパスワード(6文字以上)を入力してから「新規登録」を押してください。", true);
    return;
  }
  const { error } = await db.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  if (error) {
    showLogin(authErrorMessage(error), true);
    return;
  }
  showLogin("確認メールを送信しました。メールのリンクを開いてから、ここでログインしてください。");
});

logoutBtn.addEventListener("click", async () => {
  await db.auth.signOut();
  rules = [];
  showLogin("ログアウトしました。");
});

window.addEventListener("DOMContentLoaded", () => {
  enableLocalAi((message) => showStatus(message));
  renderEngineNote();
  startAdmin();
});
