// ===== オンライン保存(Supabase) =====
// 公開用のキーです(閲覧のみ可能。追加・変更は管理者ログインが必要)
const SUPABASE_URL = "https://sjzfxsxcvhujnsmqivob.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqemZ4c3hjdmh1am5zbXFpdm9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQxODgyODQsImV4cCI6MjEwOTc2NDI4NH0.41lTl1UIA-6kbIZfPzZNxB28dDlcVIngs7nBzIChyL8";
const FILE_BUCKET = "rule-files";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

function rowToRule(row) {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    sourceText: row.source_text,
    blocks: row.blocks || [],
    translations: row.translations || {},
    blockTranslations: row.block_translations || {},
    pdfName: row.pdf_name || "",
    pendingLangs: row.pending_langs || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ruleToRow(rule) {
  return {
    id: rule.id,
    title: rule.title,
    mode: rule.mode,
    source_text: rule.sourceText,
    blocks: rule.blocks || [],
    translations: rule.translations || {},
    block_translations: rule.blockTranslations || {},
    pdf_name: rule.pdfName || null,
    pending_langs: rule.pendingLangs || [],
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
}

async function fetchRules() {
  const { data, error } = await db.from("rules").select("*").order("updated_at", { ascending: false });
  if (error) throw new Error(`ルールを読み込めませんでした: ${error.message}`);
  return data.map(rowToRule).map(mergeLocalTranslations);
}

async function saveRule(rule) {
  const { error } = await db.from("rules").upsert(ruleToRow(rule));
  if (error) throw new Error(`ルールを保存できませんでした: ${error.message}`);
  await loadContentAuthors().catch(() => {});
}

async function deleteRule(ruleId) {
  const { error } = await db.from("rules").delete().eq("id", ruleId);
  if (error) throw new Error(`ルールを削除できませんでした: ${error.message}`);
}

// ===== 利用者の端末で追加翻訳した言語(その端末だけに保存) =====
const LOCAL_TR_KEY = "company-rule-local-translations-v1";

function readLocalTranslations() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_TR_KEY) || "{}");
  } catch {
    return {};
  }
}

function mergeLocalTranslations(rule) {
  const local = readLocalTranslations()[rule.id];
  if (!local || local.version !== rule.updatedAt) return rule; // ルールが更新されたら古い翻訳は使わない
  Object.entries(local.langs || {}).forEach(([lang, entry]) => {
    if (rule.translations[lang]) return;
    rule.translations[lang] = entry.text;
    if (entry.blocks) rule.blockTranslations[lang] = entry.blocks;
  });
  return rule;
}

function storeTranslation(rule, lang, text, blockTexts = null) {
  rule.translations = { ...rule.translations, [lang]: text };
  if (blockTexts) rule.blockTranslations = { ...rule.blockTranslations, [lang]: blockTexts };
  try {
    const all = readLocalTranslations();
    const entry = all[rule.id]?.version === rule.updatedAt ? all[rule.id] : { version: rule.updatedAt, langs: {} };
    entry.langs[lang] = { text, blocks: blockTexts };
    all[rule.id] = entry;
    localStorage.setItem(LOCAL_TR_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくても表示は続ける */
  }
  return rule;
}

// ===== PDF・元ファイル(Supabase Storage) =====
const fileKey = (ruleId, lang) => `${ruleId}/${lang}`;

async function savePdf(ruleId, lang, blob) {
  const { error } = await db.storage.from(FILE_BUCKET).upload(fileKey(ruleId, lang), blob, {
    upsert: true,
    contentType: blob.type || "application/pdf",
    cacheControl: "60",
  });
  if (error) throw new Error(`ファイルを保存できませんでした: ${error.message}`);
}

async function loadPdf(ruleId, lang, version = "") {
  const { data } = db.storage.from(FILE_BUCKET).getPublicUrl(fileKey(ruleId, lang));
  const response = await fetch(`${data.publicUrl}?v=${encodeURIComponent(version || Date.now())}`);
  if (!response.ok) return null;
  const blob = await response.blob();
  const type = response.headers.get("content-type") || blob.type || "application/pdf";
  return new Blob([blob], { type });
}

async function deleteRulePdfs(ruleId, keepLangs = []) {
  const { data, error } = await db.storage.from(FILE_BUCKET).list(ruleId, { limit: 1000 });
  if (error) throw new Error(`ファイル一覧を取得できませんでした: ${error.message}`);
  const targets = (data || []).map((item) => item.name).filter((name) => !keepLangs.includes(name)).map((name) => `${ruleId}/${name}`);
  if (targets.length) {
    const { error: removeError } = await db.storage.from(FILE_BUCKET).remove(targets);
    if (removeError) throw new Error(`ファイルを削除できませんでした: ${removeError.message}`);
  }
}

// ===== 管理者ログイン =====
async function checkIsAdmin() {
  const { data, error } = await db.rpc("is_admin");
  return !error && data === true;
}

function authErrorMessage(error) {
  const message = error?.message || "";
  if (/invalid login credentials/i.test(message)) return "メールアドレスまたはパスワードが違います。";
  if (/email not confirmed/i.test(message)) return "メールアドレスの確認が済んでいません。届いた確認メールのリンクを開いてください。";
  if (/already registered/i.test(message)) return "このメールアドレスは登録済みです。ログインしてください。";
  if (/password/i.test(message) && /at least/i.test(message)) return "パスワードは6文字以上にしてください。";
  if (/rate limit/i.test(message)) return "短時間に操作が多すぎます。しばらく待ってからお試しください。";
  return message || "エラーが発生しました。";
}

// ===== 毎日の連絡(Supabase) =====
function rowToNotice(row) {
  return {
    id: row.id,
    date: row.notice_date,
    title: row.title,
    body: row.body || "",
    translations: row.translations || {},
    attachments: row.attachments || [],
    priority: row.priority || "normal",
    pinnedUntil: row.pinned_until || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchNotices(limit = 90) {
  const { data, error } = await db
    .from("notices")
    .select("*")
    .order("notice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`連絡を読み込めませんでした: ${error.message}`);
  return data.map(rowToNotice);
}

async function saveNotice(notice) {
  const { error } = await db.from("notices").upsert({
    id: notice.id,
    notice_date: notice.date,
    title: notice.title,
    body: notice.body,
    translations: notice.translations,
    attachments: notice.attachments || [],
    priority: notice.priority || "normal",
    pinned_until: notice.priority && notice.priority !== "normal" && notice.pinnedUntil ? notice.pinnedUntil : null,
    created_at: notice.createdAt,
    updated_at: notice.updatedAt,
  });
  if (error) throw new Error(`連絡を保存できませんでした: ${error.message}`);
  await loadContentAuthors().catch(() => {});
}

async function deleteNotice(noticeId) {
  const { error } = await db.from("notices").delete().eq("id", noticeId);
  if (error) throw new Error(`連絡を削除できませんでした: ${error.message}`);
}

// 日本の日付(YYYY-MM-DD)
function todayInJapan() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function dateKeyInJapan(isoTimestamp) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(isoTimestamp));
}

// ===== お知らせの添付ファイル(写真・PDFなど) =====
// 保存名は英数字だけにする(日本語のファイル名は表示用に別に保存)
async function uploadNoticeFile(noticeId, file) {
  const ext = (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "bin").toLowerCase();
  const key = `notice-files/${noticeId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from(FILE_BUCKET).upload(key, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: "3600",
  });
  if (error) throw new Error(`「${file.name}」をアップロードできませんでした: ${error.message}`);
  return { name: file.name, path: key, type: file.type || "", size: file.size };
}

async function deleteStoredFiles(paths) {
  if (!paths.length) return;
  const { error } = await db.storage.from(FILE_BUCKET).remove(paths);
  if (error) throw new Error(`ファイルを削除できませんでした: ${error.message}`);
}

function storedFileUrl(filePath, downloadName = "") {
  const { data } = db.storage.from(FILE_BUCKET).getPublicUrl(filePath, downloadName ? { download: downloadName } : undefined);
  return data.publicUrl;
}

// ===== 追加・更新した管理者(管理者だけが読める記録) =====
const contentAuthors = new Map(); // "rule|id" / "notice|id" -> 記録

async function loadContentAuthors() {
  const { data, error } = await db.from("content_authors").select("*");
  if (error) throw new Error(`作成者の記録を読み込めませんでした: ${error.message}`);
  contentAuthors.clear();
  (data || []).forEach((row) => contentAuthors.set(`${row.content_type}|${row.content_id}`, row));
}

function authorLine(type, id) {
  const record = contentAuthors.get(`${type}|${id}`);
  if (!record) return "";
  const format = (time) => new Date(time).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const updatedLater = record.updated_by !== record.created_by || new Date(record.updated_at) - new Date(record.created_at) > 60 * 1000;
  return `
    <p class="author-line" title="この表示は管理者だけに見えます">
      <span aria-hidden="true">👤</span>
      追加: ${escapeHtml(record.created_by || "(不明)")}(${format(record.created_at)})
      ${updatedLater ? `<br />更新: ${escapeHtml(record.updated_by || "(不明)")}(${format(record.updated_at)})` : ""}
    </p>`;
}
