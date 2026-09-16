// tw_stock_db客製: 2026-09-16使用者要求——桌面版CLI模式（`-p`，見main.js
// runCliPrompt的說明）的輸出格式化，純字串處理，不需要DOM，獨立成這個檔案
// 讓main.js（Node環境，沒有document/window）可以直接require()使用。
//
// result是main.js組出來的結構化物件：
//   { prompt, response, model, toolCalls, elapsedMs }
// response是AI回覆的原始markdown文字（来自fa.messages裡最後一則assistant
// 訊息的.content，已經天生不含任何GUI widget payload——見計畫文件「既有
// 可重用的架構」段落的說明：_buildToolResultMessage把3D場景/Mermaid/繪圖等
// 實際payload存進非可枚舉的msg._display*屬性，msg.content本身只留一句
// 提示文字，不需要CLI這邊另外過濾）。
"use strict";

// ============================================================
// 純文字＋ASCII art（預設格式）
// ============================================================

// markdown pipe表格偵測：連續兩行以上都是`| a | b |`格式（含分隔線
// `|---|---|`），才視為一個表格區塊；其餘情況一律當成一般文字，不硬猜。
function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}
function isTableSeparatorRow(line) {
  const t = line.trim();
  if (!isTableRow(t)) return false;
  return /^\|[\s:|-]+\|$/.test(t) && t.includes("-");
}
function splitTableRow(line) {
  const t = line.trim().slice(1, -1); // 去掉頭尾的|
  return t.split("|").map((c) => c.trim());
}

// 依每欄最大寬度（含中日韓全形字元的顯示寬度概估，避免中文內容把表格
// 撐得歪七扭八——粗略用「非ASCII字元算2倍寬度」，不是完整的Unicode East
// Asian Width規則，但已經涵蓋這個專案最常見的中文/英文混排情境）。
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-￯]/.test(ch) ? 2 : 1;
  }
  return w;
}
function padDisplay(s, width) {
  const w = displayWidth(s);
  return s + " ".repeat(Math.max(0, width - w));
}

function renderAsciiTable(headerCells, rows) {
  const colCount = headerCells.length;
  const widths = headerCells.map((h) => displayWidth(h));
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i < colCount) widths[i] = Math.max(widths[i], displayWidth(cell || ""));
    });
  }
  const rule = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const renderRow = (cells) =>
    "|" + widths.map((w, i) => " " + padDisplay(cells[i] || "", w) + " ").join("|") + "|";
  const lines = [rule, renderRow(headerCells), rule];
  for (const row of rows) lines.push(renderRow(row));
  lines.push(rule);
  return lines.join("\n");
}

// 拿掉**粗體**/*斜體*/`inline code`的符號（終端機預設無法呈現樣式，保留
// 符號只會變成雜訊）——條列項目跟一般段落文字共用同一份規則，不要各自
// implement一次導致遺漏（實測踩過：條列分支原本沒套用，語音代號清單裡
// 的`af_heart`這類inline code反引號留在輸出裡）。
function stripInlineStyles(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

// 掃過整段markdown文字，把連續的表格行區塊換成ASCII方框表格，其餘行做
// 基本的標題/粗體/條列轉換後原樣保留。這是逐行掃描，不是完整的markdown
// parser——涵蓋常見、高頻的構造，不求100%還原markdown規格（見計畫已知
// 限制）。
function markdownToPlainText(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 表格區塊：目前行是表格列、下一行是分隔線列，才當成表格開始。
    if (isTableRow(line) && isTableSeparatorRow(lines[i + 1] || "")) {
      const headerCells = splitTableRow(line);
      i += 2; // 跳過header跟分隔線
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(renderAsciiTable(headerCells, rows));
      out.push("");
      continue;
    }

    // 標題：# / ## / ### ... → 文字本身 + 底線裝飾（#越多裝飾字元越輕，
    // 一級標題用'='、其餘用'-'，呼應html <h1>比<h2>更醒目的既有直覺）。
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      out.push(text);
      out.push((level === 1 ? "=" : "-").repeat(Math.max(displayWidth(text), 3)));
      i++;
      continue;
    }

    // 條列：-/*/+開頭 → 統一成•，縮排比照原本的前導空白數。內容本身一樣
    // 可能帶**粗體**/`code`（剛好是這次拿真實AI回覆測試時抓到的真實案例：
    // 語音清單的每個條列項目都用`code`標記語音代號），要跟下面一般文字
    // 同一套inline樣式清除，不能漏掉這個分支。
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      out.push(`${bulletMatch[1]}• ${stripInlineStyles(bulletMatch[2])}`);
      i++;
      continue;
    }

    // code fence：整段``` ... ```之間每行加4格縮排，不額外畫框（跟一般
    // 段落用空行隔開即可，終端機閱讀夠用）。
    if (/^```/.test(line.trim())) {
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        out.push("    " + lines[i]);
        i++;
      }
      i++; // 跳過結尾的```
      continue;
    }

    // 其餘一般文字：拿掉**粗體**/*斜體*/`inline code`的符號（終端機預設
    // 無法呈現樣式，保留符號只會變成雜訊），其餘原樣保留。
    out.push(stripInlineStyles(line));
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatText(result) {
  return markdownToPlainText(result.response);
}

// ============================================================
// md：原始markdown文字，不做任何轉換
// ============================================================
function formatMd(result) {
  return result.response;
}

// ============================================================
// json：結構化封裝
// ============================================================
function toEnvelope(result) {
  return {
    ok: true,
    prompt: result.prompt,
    response: result.response,
    model: result.model || null,
    tool_calls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
    elapsed_ms: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
  };
}
function formatJson(result) {
  return JSON.stringify(toEnvelope(result), null, 2);
}

// ============================================================
// toon：TOON (Token-Oriented Object Notation) 核心子集編碼器
// 依官方spec（https://github.com/toon-format/toon）的核心子集實作：
//   - 純量：數字/布林/null原樣輸出；字串含逗號/冒號/換行/前後空白/雙引號
//     時才加引號（JSON風格escape），否則裸字輸出。
//   - 物件：`key: value`，巢狀物件縮排2格。
//   - 陣列：
//     - 純量陣列 → `key[N]: v1,v2,v3`（inline逗號分隔）
//     - 「相同欄位集合的純量物件」陣列 → tabular form：
//       `key[N]{field1,field2}:` 之後每行縮排2格、逗號分隔值
//     - 不齊一的物件陣列 → 退回每個元素各自巢狀展開，前面加`-`
// 這次CLI輸出用不到「不齊一物件陣列」/「keyed tabular form([N:])」/
// 「巢狀欄位群組折疊(temp{min,max})」這幾種進階語法，沒有實作（見計畫
// 已知限制：這是核心子集，不是完整規格）。
// ============================================================

function toonNeedsQuote(s) {
  return /[,:\n"]/.test(s) || s.trim() !== s || s === "";
}
function toonQuote(s) {
  return JSON.stringify(s); // 雙引號+標準JSON escape，TOON字串引號規則與JSON相容
}
function toonScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return toonNeedsQuote(s) ? toonQuote(s) : s;
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
// 陣列裡每個元素都是「純量欄位的物件」、且欄位集合完全一致時，才適用
// tabular form；否則回傳null代表這個陣列不走tabular form。
function uniformObjectArrayFields(arr) {
  if (!arr.length || !arr.every(isPlainObject)) return null;
  const fieldSets = arr.map((o) => Object.keys(o));
  const first = fieldSets[0];
  const sameFields = fieldSets.every((f) => f.length === first.length && f.every((k, i) => k === first[i]));
  if (!sameFields) return null;
  const allScalar = arr.every((o) => first.every((k) => !isPlainObject(o[k]) && !Array.isArray(o[k])));
  return allScalar ? first : null;
}

function toonEncodeValue(key, value, indent, lines) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    const fields = uniformObjectArrayFields(value);
    if (fields) {
      lines.push(`${pad}${key}[${value.length}]{${fields.join(",")}}:`);
      for (const obj of value) {
        lines.push(`${pad}  ${fields.map((f) => toonScalar(obj[f])).join(",")}`);
      }
      return;
    }
    const allScalarArray = value.every((v) => !isPlainObject(v) && !Array.isArray(v));
    if (allScalarArray) {
      const joined = value.map(toonScalar).join(",");
      lines.push(joined ? `${pad}${key}[${value.length}]: ${joined}` : `${pad}${key}[${value.length}]:`);
      return;
    }
    // 不齊一/巢狀物件陣列：退回每個元素各自展開，前面加'-'。
    lines.push(`${pad}${key}[${value.length}]:`);
    for (const item of value) {
      if (isPlainObject(item)) {
        lines.push(`${pad}  -`);
        for (const [k, v] of Object.entries(item)) toonEncodeValue(k, v, indent + 2, lines);
      } else {
        lines.push(`${pad}  - ${toonScalar(item)}`);
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    lines.push(`${pad}${key}:`);
    for (const [k, v] of Object.entries(value)) toonEncodeValue(k, v, indent + 1, lines);
    return;
  }
  lines.push(`${pad}${key}: ${toonScalar(value)}`);
}

function toonEncode(value) {
  if (!isPlainObject(value)) {
    // 頂層不是物件（純量/陣列）：TOON規格本身以物件為主要頂層容器，這裡
    // 簡單處理成一行純量或用一個無名key包住陣列，這次的實際輸出（CLI
    // 結果envelope）一定是物件，這個分支只是防禦性寫法。
    return Array.isArray(value) ? (() => { const l = []; toonEncodeValue("value", value, 0, l); return l.join("\n"); })() : toonScalar(value);
  }
  const lines = [];
  for (const [k, v] of Object.entries(value)) toonEncodeValue(k, v, 0, lines);
  return lines.join("\n");
}

function formatToon(result) {
  return toonEncode(toEnvelope(result));
}

// ============================================================
function formatResult(result, outputFormat) {
  if (outputFormat === "json") return formatJson(result);
  if (outputFormat === "toon") return formatToon(result);
  if (outputFormat === "md") return formatMd(result);
  return formatText(result);
}

module.exports = { formatResult, formatText, formatMd, formatJson, formatToon, toonEncode, markdownToPlainText, renderAsciiTable };
