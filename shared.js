// 管理者画面・利用者画面で共通に使う処理
const STORAGE_KEY = "company-rule-pdf-translator-v1";
const LANGUAGE_CODES = `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`.split(" ");
const languageNames = new Intl.DisplayNames(["ja"], { type: "language" });
const LANGS = {
  ja: { label: "日本語", name: "日本語" },
  ...Object.fromEntries(LANGUAGE_CODES.filter((code) => code !== "ja").map((code) => {
    const name = languageNames.of(code) || code;
    return [code, { label: name, name }];
  })),
};

// 各言語の自国語表記(利用者が自分の言語を見つけやすくするため)
function nativeLanguageName(code) {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) || "";
  } catch {
    return "";
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 利用者画面で特定ルールを開くURL(QRコード用)
function userUrlFor(ruleId) {
  const base = window.location.href.split("#")[0].replace(/[^/]*$/, "");
  return `${base}user.html#rule-${ruleId}`;
}

function qrImageUrl(ruleId) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(userUrlFor(ruleId))}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ===== 翻訳(MyMemory 無料API) =====
function splitTranslationText(text, limit = 450) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("。", limit);
    if (boundary < limit * 0.55) boundary = limit;
    else boundary += 1;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

let myMemoryBlocked = false; // 上限に達したら、その後はすぐ次の方法へ

function limitError() {
  myMemoryBlocked = true;
  const error = new Error("翻訳サービスの利用上限に達しました。時間をおいて再度お試しください。");
  error.code = "limit";
  return error;
}

async function translateWithMyMemory(text, lang) {
  if (myMemoryBlocked) throw limitError();
  const chunks = splitTranslationText(text);
  const translatedChunks = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({ q: chunk, langpair: `ja|${lang}` });
    const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
    if (response.status === 429) throw limitError();
    if (!response.ok) throw new Error(`${LANGS[lang].name}の翻訳サービスに接続できませんでした。`);
    const result = await response.json();
    if (/^MYMEMORY WARNING/i.test(result.responseData?.translatedText || "")) throw limitError();
    if (Number(result.responseStatus) !== 200 || !result.responseData?.translatedText) {
      throw new Error(`${LANGS[lang].name}の翻訳に失敗しました。`);
    }
    const decoded = new DOMParser().parseFromString(result.responseData.translatedText, "text/html").documentElement.textContent;
    translatedChunks.push(decoded);
  }
  return translatedChunks.join("");
}

// ===== 端末内キャッシュ(IndexedDB): 利用者の端末で作った翻訳PDFを保存 =====
const PDF_DB_NAME = "company-rule-pdfs";
const PDF_STORE = "pdfs";
let pdfDbPromise = null;

function openPdfDb() {
  if (!pdfDbPromise) {
    pdfDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PDF_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(PDF_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return pdfDbPromise;
}

async function pdfTransaction(mode, action) {
  const db = await openPdfDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, mode);
    const request = action(tx.objectStore(PDF_STORE));
    let result;
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const pdfKey = (ruleId, lang) => `${ruleId}|${lang}`;
const localSavePdf = (ruleId, lang, blob) => pdfTransaction("readwrite", (store) => store.put(blob, pdfKey(ruleId, lang)));
const localLoadPdf = (ruleId, lang) => pdfTransaction("readonly", (store) => store.get(pdfKey(ruleId, lang)));

// ルールのPDFを削除(keepLangs に含まれる言語は残す)
async function localDeleteRulePdfs(ruleId, keepLangs = []) {
  const keys = (await pdfTransaction("readonly", (store) => store.getAllKeys())) || [];
  const targets = keys.filter((key) => key.startsWith(`${ruleId}|`) && !keepLangs.includes(key.split("|")[1]));
  if (targets.length) await pdfTransaction("readwrite", (store) => { targets.forEach((key) => store.delete(key)); });
}

// ===== 翻訳PDFの作成 =====
// ブラウザのフォントで文字を描画してPDFにするため、ミャンマー語・ネパール語・アラビア語など
// jsPDF標準フォントでは表示できない文字も正しく出力できる
const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv"]);
const PDF_FONT = `"Segoe UI", "Nirmala UI", "Myanmar Text", "Leelawadee UI", "Ebrima", "Yu Gothic", "Hiragino Sans", "Noto Sans", system-ui, sans-serif`;

function wrapCanvasText(ctx, text, maxWidth, lang) {
  const lines = [];
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(lang, { granularity: "word" }) : null;
  for (const paragraph of String(text).split(/\n+/)) {
    const pieces = segmenter ? Array.from(segmenter.segment(paragraph), (s) => s.segment) : paragraph.split(/(\s+)/);
    let line = "";
    for (const piece of pieces) {
      const candidate = line + piece;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = piece.trimStart();
      // 1語が1行に収まらない場合は文字単位で分割
      while (line && ctx.measureText(line).width > maxWidth) {
        const chars = Array.from(line);
        let cut = chars.length - 1;
        while (cut > 1 && ctx.measureText(chars.slice(0, cut).join("")).width > maxWidth) cut -= 1;
        lines.push(chars.slice(0, cut).join(""));
        line = chars.slice(cut).join("");
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    lines.push("");
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

function pdfNote(lang) {
  if (lang === "ja") return "日本語原文";
  return `${LANGS[lang]?.name || lang}(自動翻訳) ・ 正式な内容は日本語原文を確認してください`;
}

async function createTextPdf({ title, text, lang }) {
  const { jsPDF } = window.jspdf;
  const W = 1240;
  const H = 1754; // A4 / 150dpi
  const margin = 110;
  const maxWidth = W - margin * 2;
  const lineHeight = 52;
  const rtl = RTL_LANGS.has(lang);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if ("lang" in ctx) ctx.lang = lang;
  ctx.textBaseline = "top";

  const setDir = (isRtl) => {
    ctx.direction = isRtl ? "rtl" : "ltr";
    ctx.textAlign = isRtl ? "right" : "left";
    return isRtl ? W - margin : margin;
  };

  ctx.font = `bold 44px ${PDF_FONT}`;
  const titleLines = wrapCanvasText(ctx, title, maxWidth, "ja");
  ctx.font = `30px ${PDF_FONT}`;
  const bodyLines = wrapCanvasText(ctx, text, maxWidth, lang);

  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  let page = 0;
  let index = 0;
  do {
    page += 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    let y = margin;

    if (page === 1) {
      let x = setDir(false);
      ctx.fillStyle = "#1d2a4b";
      ctx.font = `bold 44px ${PDF_FONT}`;
      titleLines.forEach((line) => { ctx.fillText(line, x, y); y += 62; });
      ctx.font = `24px ${PDF_FONT}`;
      ctx.fillStyle = "#6b7a9c";
      ctx.fillText(pdfNote(lang), x, y + 6);
      y += 50;
      ctx.fillStyle = "#c9d8ff";
      ctx.fillRect(margin, y, maxWidth, 3);
      y += 36;
    }

    const x = setDir(rtl);
    ctx.fillStyle = "#1d2a4b";
    ctx.font = `30px ${PDF_FONT}`;
    while (index < bodyLines.length && y + lineHeight <= H - margin) {
      ctx.fillText(bodyLines[index], x, y);
      y += lineHeight;
      index += 1;
    }

    setDir(false);
    ctx.textAlign = "center";
    ctx.font = `22px ${PDF_FONT}`;
    ctx.fillStyle = "#6b7a9c";
    ctx.fillText(String(page), W / 2, H - 70);

    if (page > 1) pdf.addPage();
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.85), "JPEG", 0, 0, 595.28, 841.89);
  } while (index < bodyLines.length);

  return pdf.output("blob");
}

// 保存済みPDFを取得(オンライン → 端末キャッシュ → その場で作成)
async function getRulePdf(rule, lang) {
  const version = rule.updatedAt || "";
  const remote = await loadPdf(rule.id, lang, version).catch(() => null);
  if (remote) return remote;
  const cacheKey = `${lang}@${version}`;
  const cached = await localLoadPdf(rule.id, cacheKey).catch(() => null);
  if (cached) return cached;

  let blob = null;
  if (rule.mode === "layout" && rule.blocks?.length) {
    const texts = lang === "ja" ? null : rule.blockTranslations?.[lang];
    const source = lang === "ja" || texts ? await loadPdf(rule.id, "src", version).catch(() => null) : null;
    if (source) {
      const pages = await renderSourcePages(source);
      blob = await createOverlayPdf(pages.map((page) => page.canvas), rule.blocks, texts, lang);
    }
  }
  if (!blob) {
    const text = rule.translations?.[lang];
    if (!text) return null;
    blob = await createTextPdf({ title: rule.title, text, lang });
  }
  await localSavePdf(rule.id, cacheKey, blob).catch(() => {});
  return blob;
}

// ===== PDF表示(pdf.jsでページを描画。スマホでも表示できる) =====
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function renderPdfInto(container, blob) {
  const token = Symbol("render");
  container.pdfToken = token;
  container.innerHTML = '<p class="pdf-loading">PDFを表示しています…</p>';
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  if (container.pdfToken !== token) return;
  container.innerHTML = "";
  const width = container.clientWidth || 600;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    if (container.pdfToken !== token) return;
    const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * ratio });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page";
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pdfFileName(rule, lang) {
  return `${rule.title}_${LANGS[lang]?.name || lang}.pdf`.replace(/[\\/:*?"<>|]/g, "_");
}

// ===== 翻訳エンジン =====
// 1) PCのChrome内蔵翻訳(無料・キー不要・上限なし) 2) 使えない言語は MyMemory(無料・1日の上限あり)
const chromeTranslators = new Map();
const chromeUnavailable = new Set(); // 一度使えなかった言語は MyMemory に任せる

// 応答がない場合に処理が止まらないよう時間制限を付ける
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function translateWithChrome(text, lang) {
  if (!("Translator" in self) || chromeUnavailable.has(lang)) return null;
  try {
    let translator = chromeTranslators.get(lang);
    if (!translator) {
      const availability = await withTimeout(self.Translator.availability({ sourceLanguage: "ja", targetLanguage: lang }), 5000);
      if (availability === "unavailable") throw new Error("unavailable");
      translator = await withTimeout(self.Translator.create({ sourceLanguage: "ja", targetLanguage: lang }), 20000);
      chromeTranslators.set(lang, translator);
    }
    return await withTimeout(translator.translate(text), 20000);
  } catch {
    chromeUnavailable.add(lang);
    return null;
  }
}

// 翻訳の順番: 1) Chrome内蔵翻訳 2) PC内の翻訳AI(管理者画面のみ) 3) MyMemory(オンライン・上限あり)
const translationEnginesUsed = new Set(); // 直近の翻訳で使った方法(画面表示用)

async function translateText(text, lang) {
  const viaChrome = await translateWithChrome(text, lang);
  if (viaChrome) {
    translationEnginesUsed.add("Chrome内蔵翻訳");
    return viaChrome;
  }
  const viaLocalAi = await translateWithLocalAi(text, lang);
  if (viaLocalAi) {
    translationEnginesUsed.add("翻訳AI");
    return viaLocalAi;
  }
  const viaMyMemory = await translateWithMyMemory(text, lang);
  translationEnginesUsed.add("MyMemory");
  return viaMyMemory;
}

function hasChromeTranslator() {
  return "Translator" in self;
}

// ===== 元ファイル(PDF・画像)をページ画像にする =====
const PAGE_WIDTH = 1240;

async function renderSourcePages(file) {
  const pages = [];
  if ((file.type || "").startsWith("image/")) {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("画像を読み込めませんでした。"));
        img.src = url;
      });
      const scale = PAGE_WIDTH / image.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = PAGE_WIDTH;
      canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      pages.push({ canvas, items: [] });
    } finally {
      URL.revokeObjectURL(url);
    }
    return pages;
  }

  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: PAGE_WIDTH / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const textContent = await page.getTextContent();
    const items = textContent.items
      .filter((item) => item.str && item.str.trim())
      .map((item) => {
        const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
        if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) return null; // 縦書き・回転は対象外
        const height = Math.hypot(tx[2], tx[3]);
        return { x0: tx[4], y0: tx[5] - height, x1: tx[4] + item.width * viewport.scale, y1: tx[5], h: height, text: item.str };
      })
      .filter(Boolean);
    pages.push({ canvas, items });
  }
  return pages;
}

// ===== 日本語テキストの位置をまとめる =====
const JA_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/;
const CJK_EDGE = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;

function joinText(first, second) {
  if (!first) return second;
  const needsSpace = !CJK_EDGE.test(first.slice(-1)) && !CJK_EDGE.test(second[0] || "");
  return needsSpace ? `${first} ${second}` : first + second;
}

function cleanOcrText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/([\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]) (?=[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef])/g, "$1")
    .trim();
}

function groupItemsIntoLines(items) {
  const lines = [];
  [...items].sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0).forEach((item) => {
    const line = lines.find((candidate) =>
      Math.abs(candidate.y1 - item.y1) < Math.min(candidate.h, item.h) * 0.5
      && item.x0 - candidate.x1 < Math.max(candidate.h, item.h) * 2
      && item.x1 > candidate.x0);
    if (line) {
      line.text = joinText(line.text, item.text);
      line.x0 = Math.min(line.x0, item.x0);
      line.x1 = Math.max(line.x1, item.x1);
      line.y0 = Math.min(line.y0, item.y0);
      line.y1 = Math.max(line.y1, item.y1);
      line.h = Math.max(line.h, item.h);
    } else {
      lines.push({ ...item });
    }
  });
  return lines;
}

function groupLinesIntoBlocks(lines, page) {
  const blocks = [];
  [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).forEach((line) => {
    const block = blocks.find((candidate) =>
      line.y0 - candidate.y1 < line.h * 0.9
      && line.y0 >= candidate.y0
      && line.x0 < candidate.x1
      && line.x1 > candidate.x0
      && Math.abs(line.h - candidate.lineHeight) < candidate.lineHeight * 0.5);
    if (block) {
      block.text = joinText(block.text, line.text);
      block.x0 = Math.min(block.x0, line.x0);
      block.x1 = Math.max(block.x1, line.x1);
      block.y1 = Math.max(block.y1, line.y1);
      block.lines += 1;
    } else {
      blocks.push({ page, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, lineHeight: line.h, lines: 1, text: line.text });
    }
  });
  return blocks
    .map((block) => ({ ...block, text: block.text.trim() }))
    .filter((block) => JA_PATTERN.test(block.text));
}

// ===== 翻訳を元のページに書き込む(写真・レイアウトはそのまま) =====
function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
  else ctx.rect(x, y, width, height);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function drawTranslationLabel(ctx, block, text, lang, placed) {
  const pageW = ctx.canvas.width;
  const pageH = ctx.canvas.height;
  const margin = 12;
  const pad = 8;
  const rtl = RTL_LANGS.has(lang);
  const width = Math.min(pageW - margin * 2, Math.max(block.x1 - block.x0 + pad * 2, pageW * 0.3));
  const x = Math.min(Math.max(block.x0 - pad, margin), pageW - margin - width);

  let size = Math.max(16, Math.min(30, block.lineHeight * 0.62));
  let lines;
  do {
    ctx.font = `bold ${size}px ${PDF_FONT}`;
    lines = wrapCanvasText(ctx, text, width - pad * 2, lang).filter((line, i, all) => line || (i > 0 && i < all.length - 1));
    if (lines.length <= 4 || size <= 14) break;
    size -= 2;
  } while (true);
  const lineHeight = Math.round(size * 1.3);
  const height = lines.length * lineHeight + pad * 2;

  let y = block.y1 + 4;
  if (y + height > pageH - margin) y = Math.max(margin, block.y0 - height - 4);
  // 他の翻訳ボックスと重ならないよう下にずらす
  for (let tries = 0; tries < 6; tries += 1) {
    const hit = placed.find((rect) => overlaps(rect, { x, y, w: width, h: height }));
    if (!hit) break;
    y = Math.min(hit.y + hit.h + 4, pageH - margin - height);
  }
  placed.push({ x, y, w: width, h: height });

  ctx.save();
  roundedRect(ctx, x, y, width, height, 8);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#2f6df6";
  ctx.stroke();
  if ("lang" in ctx) ctx.lang = lang;
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#1d3fae";
  ctx.font = `bold ${size}px ${PDF_FONT}`;
  const textX = rtl ? x + width - pad : x + pad;
  lines.forEach((line, index) => ctx.fillText(line, textX, y + pad + index * lineHeight + (lineHeight - size) / 2));
  ctx.restore();
}

async function createOverlayPdf(pageCanvases, blocks, texts, lang) {
  const { jsPDF } = window.jspdf;
  let pdf = null;
  pageCanvases.forEach((source, pageIndex) => {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    if (texts) {
      const placed = [];
      blocks.forEach((block, index) => {
        if (block.page === pageIndex && texts[index]) drawTranslationLabel(ctx, block, texts[index], lang, placed);
      });
    }
    const widthPt = 595.28;
    const heightPt = (canvas.height / canvas.width) * widthPt;
    const orientation = heightPt >= widthPt ? "portrait" : "landscape";
    if (!pdf) pdf = new jsPDF({ unit: "pt", format: [widthPt, heightPt], orientation });
    else pdf.addPage([widthPt, heightPt], orientation);
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.88), "JPEG", 0, 0, widthPt, heightPt);
  });
  return pdf.output("blob");
}

// ルールの全ブロックを1言語に翻訳(1つでも失敗したらエラー)
async function translateBlocks(blocks, lang) {
  const results = [];
  for (const block of blocks) results.push(await translateText(block.text, lang));
  return results;
}

// ===== PC内で動く翻訳AI(Meta NLLB-200・200言語・無料・上限なし) =====
// 初回だけモデル(数百MB)をダウンロードし、ブラウザに保存して再利用する。文書は外部に送信されない。
const LOCAL_AI_MODEL = "Xenova/nllb-200-distilled-600M";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
const NLLB_CODES = {
  af: "afr_Latn", ak: "aka_Latn", am: "amh_Ethi", ar: "arb_Arab", as: "asm_Beng", ay: "ayr_Latn", az: "azj_Latn",
  ba: "bak_Cyrl", be: "bel_Cyrl", bg: "bul_Cyrl", bm: "bam_Latn", bn: "ben_Beng", bo: "bod_Tibt", bs: "bos_Latn",
  ca: "cat_Latn", cs: "ces_Latn", cy: "cym_Latn", da: "dan_Latn", de: "deu_Latn", dz: "dzo_Tibt", ee: "ewe_Latn",
  el: "ell_Grek", en: "eng_Latn", eo: "epo_Latn", es: "spa_Latn", et: "est_Latn", eu: "eus_Latn", fa: "pes_Arab",
  ff: "fuv_Latn", fi: "fin_Latn", fj: "fij_Latn", fo: "fao_Latn", fr: "fra_Latn", ga: "gle_Latn", gd: "gla_Latn",
  gl: "glg_Latn", gn: "grn_Latn", gu: "guj_Gujr", ha: "hau_Latn", he: "heb_Hebr", hi: "hin_Deva", hr: "hrv_Latn",
  ht: "hat_Latn", hu: "hun_Latn", hy: "hye_Armn", id: "ind_Latn", ig: "ibo_Latn", is: "isl_Latn", it: "ita_Latn",
  jv: "jav_Latn", ka: "kat_Geor", kg: "kon_Latn", ki: "kik_Latn", kk: "kaz_Cyrl", km: "khm_Khmr", kn: "kan_Knda",
  ko: "kor_Hang", ks: "kas_Arab", ku: "kmr_Latn", ky: "kir_Cyrl", lb: "ltz_Latn", lg: "lug_Latn", li: "lim_Latn",
  ln: "lin_Latn", lo: "lao_Laoo", lt: "lit_Latn", lv: "lvs_Latn", mg: "plt_Latn", mi: "mri_Latn", mk: "mkd_Cyrl",
  ml: "mal_Mlym", mn: "khk_Cyrl", mr: "mar_Deva", ms: "zsm_Latn", mt: "mlt_Latn", my: "mya_Mymr", nb: "nob_Latn",
  ne: "npi_Deva", nl: "nld_Latn", nn: "nno_Latn", no: "nob_Latn", ny: "nya_Latn", oc: "oci_Latn", om: "gaz_Latn",
  or: "ory_Orya", pa: "pan_Guru", pl: "pol_Latn", ps: "pbt_Arab", pt: "por_Latn", qu: "quy_Latn", rn: "run_Latn",
  ro: "ron_Latn", ru: "rus_Cyrl", rw: "kin_Latn", sa: "san_Deva", sc: "srd_Latn", sd: "snd_Arab", sg: "sag_Latn",
  si: "sin_Sinh", sk: "slk_Latn", sl: "slv_Latn", sm: "smo_Latn", sn: "sna_Latn", so: "som_Latn", sq: "als_Latn",
  sr: "srp_Cyrl", ss: "ssw_Latn", st: "sot_Latn", su: "sun_Latn", sv: "swe_Latn", sw: "swh_Latn", ta: "tam_Taml",
  te: "tel_Telu", tg: "tgk_Cyrl", th: "tha_Thai", ti: "tir_Ethi", tk: "tuk_Latn", tl: "tgl_Latn", tn: "tsn_Latn",
  tr: "tur_Latn", ts: "tso_Latn", tt: "tat_Cyrl", tw: "twi_Latn", ug: "uig_Arab", uk: "ukr_Cyrl", ur: "urd_Arab",
  uz: "uzn_Latn", vi: "vie_Latn", wo: "wol_Latn", xh: "xho_Latn", yi: "ydd_Hebr", yo: "yor_Latn", zh: "zho_Hans",
  zu: "zul_Latn",
};
const NO_SPACE_JOIN = new Set(["zh", "th", "my", "lo", "km", "bo", "dz"]);
let localAiEnabled = false; // 管理者画面だけで有効(スマホで大きなモデルを読み込まないため)
let localAiProgress = null;
let localAiPipeline = null;

function enableLocalAi(onProgress) {
  localAiEnabled = true;
  localAiProgress = onProgress;
}

function supportsLocalAi(lang) {
  return Boolean(NLLB_CODES[lang]);
}

// 翻訳AIは重い処理なので、画面とは別のスレッド(Web Worker)で実行する。
// 画面側で実行すると、Chromeが「ページが応答しません」と表示してしまうため。
const LOCAL_AI_WORKER_SOURCE = `
import { pipeline, env } from "${TRANSFORMERS_URL}";
env.allowLocalModels = false;
let translatorPromise = null;
const files = {};
function getTranslator() {
  if (!translatorPromise) {
    translatorPromise = pipeline("translation", "${LOCAL_AI_MODEL}", {
      dtype: "q8",
      progress_callback: (info) => {
        if (info.status !== "progress" || !info.total) return;
        files[info.file] = { loaded: info.loaded, total: info.total };
        let loaded = 0;
        let total = 0;
        for (const item of Object.values(files)) { loaded += item.loaded; total += item.total; }
        self.postMessage({ type: "progress", loaded, total });
      },
    });
  }
  return translatorPromise;
}
self.onmessage = async (event) => {
  const { id, text, tgt, maxTokens } = event.data;
  try {
    const translator = await getTranslator();
    const [result] = await translator(text, {
      src_lang: "jpn_Jpan",
      tgt_lang: tgt,
      max_new_tokens: maxTokens || 200,
      repetition_penalty: 1.3,
      no_repeat_ngram_size: 3,
    });
    self.postMessage({ type: "result", id, text: (result && result.translation_text) || "" });
  } catch (error) {
    translatorPromise = null;
    self.postMessage({ type: "error", id, message: String((error && error.message) || error) });
  }
};
`;

let localAiWorker = null;
let localAiSeq = 0;
const localAiPending = new Map();

function getLocalAiWorker() {
  if (!localAiWorker) {
    const url = URL.createObjectURL(new Blob([LOCAL_AI_WORKER_SOURCE], { type: "text/javascript" }));
    localAiWorker = new Worker(url, { type: "module" });
    localAiWorker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        localAiProgress?.(`翻訳AIを準備しています(初回のみ)… ${Math.round(message.loaded / 1048576)} / ${Math.round(message.total / 1048576)} MB`);
        return;
      }
      const pending = localAiPending.get(message.id);
      if (!pending) return;
      localAiPending.delete(message.id);
      if (message.type === "result") pending.resolve(message.text);
      else pending.reject(new Error(message.message));
    };
    localAiWorker.onerror = (event) => {
      localAiPending.forEach((pending) => pending.reject(new Error(event.message || "翻訳AIでエラーが発生しました。")));
      localAiPending.clear();
      localAiWorker = null;
    };
  }
  return localAiWorker;
}

function runLocalAi(text, targetCode) {
  // 出力が入力より極端に長くならないよう上限を付ける(作り話の防止)
  const maxTokens = Math.min(256, Math.ceil(text.length * 3) + 16);
  return new Promise((resolve, reject) => {
    localAiSeq += 1;
    localAiPending.set(localAiSeq, { resolve, reject });
    getLocalAiWorker().postMessage({ id: localAiSeq, text, tgt: targetCode, maxTokens });
  });
}

// 翻訳AIには短い単位で渡す(長い文や、メニューのような箇条書きは崩れやすいため)
function splitForLocalAi(text) {
  const pieces = [];
  String(text).split(/\n+/).forEach((line) => {
    line.split(/(?<=[。！？!?])|[　 ]+/).forEach((sentence) => {
      let rest = sentence.trim();
      while (rest.length > 80) {
        let cut = rest.lastIndexOf("、", 80);
        if (cut < 20) cut = 80;
        else cut += 1;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
    });
  });
  return pieces;
}

// 同じ語句が続けて繰り返された部分を1回にまとめる
function removeRepeats(text) {
  return text
    .replace(/(\S+(?:\s+\S+){0,3}?)(?:[\s,、，]+\1(?=[\s,、，.。!?]|$))+/giu, "$1")
    .replace(/(.{2,12}?)\1{2,}/gu, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function translateWithLocalAi(text, lang) {
  if (!localAiEnabled || !supportsLocalAi(lang)) return null;
  try {
    const lines = [];
    for (const line of String(text).split(/\n+/)) {
      const parts = [];
      for (const piece of splitForLocalAi(line)) {
        if (!JA_PATTERN.test(piece) || /^[\d,.]+\s*(円|個|枚|本|分|時間?|日|人|回|%|％)?$/.test(piece)) {
          parts.push(piece); // 数字・英語・記号だけの部分はそのまま
          continue;
        }
        parts.push(removeRepeats((await runLocalAi(piece, NLLB_CODES[lang])).trim()));
      }
      const joinedLine = parts.filter(Boolean).join(NO_SPACE_JOIN.has(lang) ? "" : " ");
      if (joinedLine) lines.push(joinedLine);
    }
    return lines.join("\n") || null;
  } catch (error) {
    console.warn("翻訳AIでの翻訳に失敗しました", error);
    return null;
  }
}
