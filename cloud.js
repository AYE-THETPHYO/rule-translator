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
