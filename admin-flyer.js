// 管理者画面: 掲示用チラシ(A4のPDF)を作る + AIにルールの下書きを作ってもらう
const FLYER_THEMES = {
  rule: { label: "ルール", en: "RULES", color: "#2f5fe0", soft: "#e9efff" },
  caution: { label: "注意", en: "CAUTION", color: "#d98200", soft: "#fff3da" },
  safety: { label: "安全", en: "SAFETY", color: "#0f8f66", soft: "#e1f5ee" },
  ban: { label: "禁止", en: "PROHIBITED", color: "#d23535", soft: "#fdeceb" },
  notice: { label: "お知らせ", en: "NOTICE", color: "#6247d0", soft: "#eee9ff" },
};
const FLYER_LANG_COLORS = ["#1d3fae", "#8a4b00", "#0b6b4f"];
const FLYER_MAX_LANGS = 3;
let flyerBlob = null;

// ルールの言葉に合う絵(絵文字)を自動で選ぶ
const FLYER_ICONS = [
  [/ヘルメット|保護帽/, "⛑️"], [/安全靴|靴/, "🥾"], [/手袋/, "🧤"], [/マスク/, "😷"],
  [/ゴーグル|保護メガネ|保護眼鏡/, "🥽"], [/耳栓/, "🎧"], [/禁煙|たばこ|タバコ|喫煙/, "🚭"],
  [/手洗い|手を洗/, "🧼"], [/火気|火事|火を/, "🔥"], [/掃除|清掃|片付|片づ|整理|整頓/, "🧹"],
  [/ごみ|ゴミ/, "🗑️"], [/静か/, "🤫"], [/飲食|食べ|飲み|食事|弁当/, "🍱"],
  [/スマホ|スマートフォン|携帯|電話/, "📱"], [/報告|連絡|相談/, "📣"], [/フォークリフト/, "🚜"],
  [/機械|設備/, "⚙️"], [/時間|遅刻|時刻/, "⏰"], [/通路|通り道/, "🚧"], [/駐車|車/, "🚗"],
  [/電気|スイッチ|照明/, "💡"], [/鍵|施錠|カギ/, "🔑"], [/避難|非常口/, "🚪"],
  [/けが|ケガ|怪我|救急/, "🩹"], [/撮影|写真/, "📷"], [/制服|作業着|作業服/, "👕"],
  [/水|濡れ/, "💧"], [/走ら|走る/, "🏃"], [/禁止|しない|ないで/, "🚫"], [/注意|気をつけ/, "⚠️"],
];

function flyerIcon(text) {
  return FLYER_ICONS.find(([pattern]) => pattern.test(text))?.[1] || "";
}

// ルールの各行と、その翻訳を組にする
function flyerItems(rule, langs) {
  if (rule.blocks?.length) {
    return rule.blocks
      .map((block, index) => ({
        ja: block.text,
        tr: Object.fromEntries(langs.map((lang) => [lang, rule.blockTranslations?.[lang]?.[index] || ""])),
      }))
      .filter((item) => item.ja.trim() && item.ja.trim() !== rule.title.trim());
  }
  const lines = (text) => String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const jaLines = lines(rule.sourceText);
  const trLines = Object.fromEntries(langs.map((lang) => [lang, lines(rule.translations?.[lang])]));
  if (langs.every((lang) => trLines[lang].length === jaLines.length)) {
    return jaLines.map((ja, index) => ({ ja, tr: Object.fromEntries(langs.map((lang) => [lang, trLines[lang][index]])) }));
  }
  // 行数が合わない場合: 日本語の項目のあとに、言語ごとにまとめて載せる
  return [
    ...jaLines.map((ja) => ({ ja, tr: {} })),
    ...langs.filter((lang) => trLines[lang].length).map((lang) => ({
      ja: LANGS[lang]?.name || lang,
      badge: lang.toUpperCase(),
      tr: { [lang]: trLines[lang].join("\n") },
    })),
  ];
}

function drawQr(ctx, text, x, y, size) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 10, y - 10, size + 20, size + 20);
  ctx.fillStyle = "#111111";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect(x + col * cell, y + row * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
}

async function createFlyerPdf({ rule, langs, theme, withQr, withIcons = false, image = null }) {
  const { jsPDF } = window.jspdf;
  const W = 1240;
  const H = 1754; // A4
  const M = 70;
  const colors = FLYER_THEMES[theme] || FLYER_THEMES.rule;
  const items = flyerItems(rule, langs);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  const maxW = W - M * 2;
  const numCol = 96;
  const icons = items.map((item) => (withIcons && !item.badge ? flyerIcon(item.ja) : ""));
  const iconCol = icons.some(Boolean) ? 120 : 0;
  const textW = maxW - numCol - 30 - iconCol;
  // 写真・イラスト(見出しの下に入れる)
  let imageBox = null;
  if (image) {
    const fit = Math.min(maxW / image.width, 380 / image.height);
    imageBox = { w: image.width * fit, h: image.height * fit, block: image.height * fit + 36 };
  }

  const setDir = (rtl) => {
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textAlign = rtl ? "right" : "left";
  };

  // ---- 見出し ----
  let titleSize = 76;
  let titleLines;
  do {
    ctx.font = `bold ${titleSize}px ${PDF_FONT}`;
    titleLines = wrapCanvasText(ctx, rule.title, maxW - 40, "ja");
    if (titleLines.length <= 2 || titleSize <= 48) break;
    titleSize -= 6;
  } while (true);
  ctx.font = `bold 32px ${PDF_FONT}`;
  const titleTr = langs
    .map((lang) => ({ lang, text: rule.titleTranslations?.[lang] || "" }))
    .filter((entry) => entry.text)
    .map((entry) => ({ ...entry, lines: wrapCanvasText(ctx, entry.text, maxW - 40, entry.lang) }));
  const headerH = 150 + titleLines.length * titleSize * 1.25 + titleTr.reduce((sum, entry) => sum + entry.lines.length * 44, 0) + 40;
  const footerH = withQr ? 250 : 80;

  // ---- 本文の大きさを、1枚に収まるように決める ----
  const measure = (scale) => {
    const jaSize = Math.round(42 * scale);
    const trSize = Math.round(31 * scale);
    const pad = 22 * scale;
    const rows = items.map((item, itemIndex) => {
      ctx.font = `bold ${jaSize}px ${PDF_FONT}`;
      const ja = wrapCanvasText(ctx, item.ja, textW, "ja");
      ctx.font = `${trSize}px ${PDF_FONT}`;
      const trs = langs
        .filter((lang) => item.tr?.[lang])
        .map((lang) => ({ lang, lines: wrapCanvasText(ctx, item.tr[lang], textW, lang) }));
      const height = pad * 2 + ja.length * jaSize * 1.35
        + trs.reduce((sum, tr) => sum + tr.lines.length * trSize * 1.4 + 8 * scale, 0);
      return { item, ja, trs, icon: icons[itemIndex], height: Math.max(height, (iconCol ? 92 : 64) * scale + pad * 2) };
    });
    const gap = 16 * scale;
    return { rows, jaSize, trSize, pad, gap, scale, total: rows.reduce((sum, row) => sum + row.height + gap, 0) };
  };
  const firstPageSpace = H - headerH - footerH - 40 - (imageBox?.block || 0);
  let layout = measure(1.3);
  for (let scale = 1.3; scale >= 0.6 && layout.total > firstPageSpace; scale -= 0.05) layout = measure(scale);

  const drawFooter = () => {
    const top = H - footerH;
    ctx.fillStyle = colors.color;
    ctx.fillRect(0, top, W, footerH);
    setDir(false);
    ctx.fillStyle = "#ffffff";
    if (withQr) {
      const size = 170;
      drawQr(ctx, userUrlFor(rule.id), W - M - size, top + 40, size);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 34px ${PDF_FONT}`;
      ctx.fillText("スマートフォンで読み取ると、", M, top + 52);
      ctx.fillText("自分の言語で読めます。", M, top + 98);
      ctx.font = `26px ${PDF_FONT}`;
      ctx.fillText("Scan the QR code to read this in your language.", M, top + 158);
    } else {
      ctx.font = `24px ${PDF_FONT}`;
      ctx.fillText("社内連絡・翻訳アプリ", M, top + 28);
    }
  };

  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  let page = 0;
  let index = 0;
  let number = 0;
  do {
    page += 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    let y;
    setDir(false);
    if (page === 1) {
      ctx.fillStyle = colors.color;
      ctx.fillRect(0, 0, W, headerH);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      roundedRect(ctx, M, 54, 30 + (colors.label.length * 40) + colors.en.length * 22 + 50, 60, 30);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 36px ${PDF_FONT}`;
      ctx.fillText(`${colors.label}  ${colors.en}`, M + 26, 66);
      y = 142;
      ctx.font = `bold ${titleSize}px ${PDF_FONT}`;
      titleLines.forEach((line) => { ctx.fillText(line, M, y); y += titleSize * 1.25; });
      ctx.font = `bold 32px ${PDF_FONT}`;
      titleTr.forEach((entry) => {
        const rtl = RTL_LANGS.has(entry.lang);
        setDir(rtl);
        if ("lang" in ctx) ctx.lang = entry.lang;
        entry.lines.forEach((line) => { ctx.fillText(line, rtl ? W - M : M, y); y += 44; });
        setDir(false);
      });
      y = headerH + 36;
      if (imageBox) {
        const left = (W - imageBox.w) / 2;
        ctx.save();
        roundedRect(ctx, left, y, imageBox.w, imageBox.h, 18);
        ctx.clip();
        ctx.drawImage(image, left, y, imageBox.w, imageBox.h);
        ctx.restore();
        y += imageBox.block;
      }
    } else {
      ctx.fillStyle = colors.color;
      ctx.fillRect(0, 0, W, 36);
      y = 36 + M;
    }

    const limit = H - footerH - 20;
    let drawn = 0;
    while (index < layout.rows.length) {
      const row = layout.rows[index];
      if (y + row.height > limit && drawn > 0) break;
      // 背景
      ctx.fillStyle = colors.soft;
      roundedRect(ctx, M, y, maxW, row.height, 22);
      ctx.fill();
      // 番号
      const radius = Math.min(32 * layout.scale + 6, 44);
      const cx = M + numCol / 2 + 6;
      const cy = y + layout.pad + radius;
      ctx.fillStyle = colors.color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const badge = row.item.badge || String(number += 1);
      ctx.font = `bold ${Math.round(radius * (badge.length > 1 ? 0.75 : 1.05))}px ${PDF_FONT}`;
      ctx.fillText(badge, cx, cy + 2);
      ctx.textBaseline = "top";
      // 日本語
      setDir(false);
      const textX = M + numCol + 20;
      let ty = y + layout.pad;
      ctx.fillStyle = "#151b2e";
      ctx.font = `bold ${layout.jaSize}px ${PDF_FONT}`;
      if ("lang" in ctx) ctx.lang = "ja";
      row.ja.forEach((line) => { ctx.fillText(line, textX, ty); ty += layout.jaSize * 1.35; });
      // 翻訳
      row.trs.forEach((tr) => {
        ty += 8 * layout.scale;
        const rtl = RTL_LANGS.has(tr.lang);
        setDir(rtl);
        if ("lang" in ctx) ctx.lang = tr.lang;
        ctx.fillStyle = FLYER_LANG_COLORS[langs.indexOf(tr.lang) % FLYER_LANG_COLORS.length];
        ctx.font = `${layout.trSize}px ${PDF_FONT}`;
        tr.lines.forEach((line) => { ctx.fillText(line, rtl ? textX + textW : textX, ty); ty += layout.trSize * 1.4; });
        setDir(false);
      });
      // 絵(アイコン)
      if (row.icon) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#151b2e";
        ctx.font = `${Math.round(Math.min(84, 70 * layout.scale))}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
        ctx.fillText(row.icon, M + maxW - iconCol / 2 - 4, y + row.height / 2 + 2);
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
      }
      y += row.height + layout.gap;
      index += 1;
      drawn += 1;
    }
    drawFooter();
    if (page > 1) pdf.addPage();
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 595.28, 841.89);
  } while (index < layout.rows.length && page < 20);
  return pdf.output("blob");
}

// ===== 画面(翻訳プレビューの下に表示) =====
window.renderFlyerCard = (rule) => {
  const card = document.getElementById("flyer-card");
  if (!card) return;
  flyerBlob = null;
  const langs = Object.keys(rule.translations).filter((code) => code !== "ja" && LANGS[code]);
  card.innerHTML = `
    <h4>🖨 掲示用チラシを作る</h4>
    <p class="muted">工場や休憩室に貼るA4のチラシ(PDF)を、このルールから自動で作ります。日本語と翻訳が並びます。</p>
    <div class="flyer-options">
      <label>
        種類
        <select id="flyer-theme">
          ${Object.entries(FLYER_THEMES).map(([key, theme]) => `<option value="${key}">${theme.label}(${theme.en})</option>`).join("")}
        </select>
      </label>
      <div>
        <strong>チラシに入れる言語(${FLYER_MAX_LANGS}つまで)</strong>
        <div class="chip-row">
          ${langs.map((code, index) => `<label class="chip flyer-lang"><input type="checkbox" value="${code}" ${index < 2 ? "checked" : ""} />${escapeHtml(LANGS[code].name)}</label>`).join("")
            || '<span class="muted">翻訳がありません(日本語だけのチラシになります)</span>'}
        </div>
      </div>
      <label class="flyer-check"><input id="flyer-qr" type="checkbox" checked /> QRコードを入れる(スマートフォンで全言語を読めます)</label>
      <label class="flyer-check"><input id="flyer-icons" type="checkbox" checked /> 絵(アイコン)を自動で入れる(ヘルメット・手袋・禁煙など)</label>
      <label>
        写真・イラストを入れる(任意)
        <input id="flyer-image" type="file" accept="image/*" />
      </label>
    </div>
    <div class="action-row">
      <button id="flyer-make" class="primary-btn" type="button">チラシを作成</button>
    </div>
    <div id="flyer-result" hidden>
      <div class="action-row">
        <button id="flyer-download" class="secondary-btn" type="button">チラシをダウンロード</button>
        <button id="flyer-print" class="secondary-btn" type="button">開いて印刷</button>
      </div>
      <div id="flyer-preview" class="pdf-viewer"></div>
    </div>
  `;

  card.querySelectorAll(".flyer-lang input").forEach((input) => {
    input.addEventListener("change", () => {
      const checked = card.querySelectorAll(".flyer-lang input:checked");
      if (checked.length > FLYER_MAX_LANGS) input.checked = false;
    });
  });

  document.getElementById("flyer-make").addEventListener("click", async () => {
    const button = document.getElementById("flyer-make");
    button.disabled = true;
    button.textContent = "作成中…";
    try {
      const imageFile = document.getElementById("flyer-image").files[0];
      flyerBlob = await createFlyerPdf({
        rule,
        withIcons: document.getElementById("flyer-icons").checked,
        image: imageFile ? await createImageBitmap(imageFile) : null,
        langs: [...card.querySelectorAll(".flyer-lang input:checked")].map((input) => input.value),
        theme: document.getElementById("flyer-theme").value,
        withQr: document.getElementById("flyer-qr").checked,
      });
      document.getElementById("flyer-result").hidden = false;
      await renderPdfInto(document.getElementById("flyer-preview"), flyerBlob);
    } catch (error) {
      showStatus(`チラシを作成できませんでした: ${error.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = "チラシを作成";
    }
  });
  document.getElementById("flyer-download").addEventListener("click", () => {
    if (flyerBlob) downloadBlob(flyerBlob, `${rule.title}_チラシ.pdf`.replace(/[\\/:*?"<>|]/g, "_"));
  });
  document.getElementById("flyer-print").addEventListener("click", () => {
    if (!flyerBlob) return;
    const url = URL.createObjectURL(flyerBlob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
};

// ===== AIにルールの下書きを作ってもらう(Chromeに入っているAI。無料・キー不要) =====
const aiTopicInput = document.getElementById("ai-topic");
const aiDraftBtn = document.getElementById("ai-draft");

async function draftRuleWithAi(topic) {
  if (!("LanguageModel" in self)) {
    throw new Error("このブラウザにはAIが入っていません。パソコンの最新のChromeで開くか、文章を自分で入力してください。");
  }
  const options = {
    expectedInputs: [{ type: "text", languages: ["ja"] }],
    expectedOutputs: [{ type: "text", languages: ["ja"] }],
  };
  const availability = await withTimeout(self.LanguageModel.availability(options), 10000);
  if (availability === "unavailable") {
    throw new Error("このパソコンではChromeのAIを使えません。文章を自分で入力してください。");
  }
  if (availability !== "available") showStatus("AIを準備しています(初回のみ、数分かかることがあります)…");
  const session = await withTimeout(self.LanguageModel.create({
    ...options,
    initialPrompts: [{
      role: "system",
      content: "あなたは日本の工場・会社の総務担当です。社内に掲示するルールを、外国人社員にも伝わる、短くやさしい日本語で書きます。",
    }],
  }), 600000);
  try {
    const answer = await withTimeout(session.prompt(
      `次のテーマで、職場に掲示するルールを作ってください。\nテーマ: ${topic}\n\n条件:\n- 1行目は「タイトル: 」に続けて短いタイトル\n- 2行目以降はルールを4〜6個。1行に1つ。番号や記号は付けない\n- 1つのルールは40文字以内。「〜してください」の形で、むずかしい言葉を使わない\n- 説明や前置きは書かない`,
    ), 180000);
    const lines = String(answer).split(/\n+/).map((line) => line.replace(/^[\s\-・*●\d.)、]+/, "").trim()).filter(Boolean);
    const titleIndex = lines.findIndex((line) => /^タイトル\s*[:：]/.test(line));
    const title = titleIndex >= 0 ? lines[titleIndex].replace(/^タイトル\s*[:：]\s*/, "") : "";
    const items = lines.filter((line, index) => index !== titleIndex);
    if (!items.length) throw new Error("AIが文章を作れませんでした。もう一度お試しください。");
    return { title, items };
  } finally {
    session.destroy?.();
  }
}

aiDraftBtn?.addEventListener("click", async () => {
  const topic = aiTopicInput.value.trim();
  if (!topic) {
    showStatus("AIに作ってほしいルールのテーマを入力してください(例: 休憩室の使い方)。", true);
    return;
  }
  aiDraftBtn.disabled = true;
  showStatus("AIがルールの下書きを作っています…");
  try {
    const draft = await draftRuleWithAi(topic);
    if (!titleInput.value.trim()) titleInput.value = draft.title || topic;
    currentBlocks = [];
    renderBlocks();
    japaneseTextInput.value = draft.items.join("\n");
    showStatus("AIが下書きを作りました。内容を確認・修正してから「翻訳する」を押してください。");
  } catch (error) {
    showStatus(error.message === "timeout" ? "AIの応答がありませんでした。文章を自分で入力してください。" : error.message, true);
  } finally {
    aiDraftBtn.disabled = false;
  }
});
