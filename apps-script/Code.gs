/**
 * K9 פיננסים — רישום רשומה לגיליון
 *
 * האפליקציה פותחת את כתובת ה-Web App הזו בלשונית חדשה, עם פרטי הרשומה
 * בכתובת. הסקריפט מוסיף את השורה ללשונית החודש המתאימה ומציג אישור.
 *
 * פריסה: Deploy → Manage deployments → ✏️ → Version: New version
 *        Execute as: Me · Who has access: Anyone
 */

const SCRIPT_VERSION = "v5";
const TOKEN = "k9-eSxNZUqsW__u2KnNLMp38a_v";
const SHEET_ID = "1gLA2t9RToM5N-LhdSSqEufR3pGdTN8ouT8Yu_Pa0o3U";

const MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני",
                "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

// עמודות טבלת ההוצאות: A תאריך, B אמצעי תשלום, C תשלומים, D תיאור, E סכום, F קטגוריה
const EXP_FIRST_ROW = 5;
let WARN = [];
const COL_DESC = 4;

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.token !== TOKEN) throw new Error("אין הרשאה (טוקן שגוי)");

    WARN = [];
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      // מניעת כפילות: אם הלשונית נטענה שוב, לא רושמים פעמיים
      const props = PropertiesService.getScriptProperties();
      if (p.id && props.getProperty("done_" + p.id)) {
        return page_(true, "הרשומה כבר נרשמה בגיליון קודם לכן.");
      }

      const amount = parseFloat(p.amt);
      if (!p.date || !p.desc || isNaN(amount)) throw new Error("חסרים פרטים ברשומה");

      const [y, m, d] = p.date.split("-").map(Number);
      const ss = SpreadsheetApp.openById(SHEET_ID);
      const sheetName = MONTHS[m - 1] + " " + String(y).slice(2);
      const sh = ss.getSheetByName(sheetName) || ss.getSheetByName(MONTHS[m - 1] + " " + y);
      if (!sh) throw new Error('לא נמצאה לשונית בשם "' + sheetName + '". צרו אותה בגיליון ונסו שוב.');

      const dateText = d + "." + m + "." + String(y).slice(2);
      let where;
      if (p.type === "income") {
        where = addIncome_(sh, dateText, p.src || p.desc, amount);
      } else {
        const inst = parseInt(p.inst, 10);
        const total = parseFloat(p.total);
        const instInfo = (inst >= 2 && total > 0) ? { count: inst, total: total } : null;
        where = addExpense_(sh, dateText, p.pay || "", p.desc, amount, p.cat || "", instInfo);
      }

      if (p.id) props.setProperty("done_" + p.id, "1");
      let msg = "נרשם בלשונית \"" + sh.getName() + "\" בשורה " + where + ".";
      if (WARN.length) msg += " שימו לב: " + WARN.join(" ");
      return page_(true, msg);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return page_(false, err.message);
  }
}

function addExpense_(sh, dateText, pay, desc, amount, cat, instInfo) {
  const last = sh.getLastRow();
  let totalRow = null;
  const dVals = sh.getRange(EXP_FIRST_ROW, COL_DESC, Math.max(1, last - EXP_FIRST_ROW + 1), 1).getValues();
  for (let i = 0; i < dVals.length; i++) {
    if (String(dVals[i][0]).trim() === 'סה"כ') { totalRow = EXP_FIRST_ROW + i; break; }
  }
  if (!totalRow) throw new Error('לא נמצאה שורת סה"כ בטבלת ההוצאות');

  const row = pickExpenseRow_(sh, totalRow, cat);
  copyCategoryFormat_(sh, row, cat);
  sh.getRange(row, 1).setNumberFormat("@");
  // תשלומים: עמודה C בפורמט של הגיליון "כן (מספר תשלומים) מספר התשלום", ובעמודה E נוסחה של סכום העסקה חלקי מספר התשלומים
  const instText = instInfo ? "כן (" + instInfo.count + ") 1" : "לא";
  sh.getRange(row, 1, 1, 6).setValues([[dateText, pay, instText, desc, amount, cat]]);
  if (instInfo) sh.getRange(row, 5).setFormula("=" + instInfo.total + "/" + instInfo.count);
  addToCategoryTotal_(sh, cat, "E" + row);
  return row;
}

/**
 * בטבלת הסיכום לפי סיווג (מקרא) כל סכום הוא נוסחה שמפרטת תאים ספציפיים,
 * למשל =SUM(E30) או =E31. מוסיפים אליה את התא של השורה החדשה.
 */
function addToCategoryTotal_(sh, cat, ref) {
  const vals = sh.getDataRange().getValues();
  let hr = -1, hc = -1;
  for (let r = 0; r < vals.length && hr < 0; r++) {
    for (let c = 0; c < vals[r].length; c++) {
      if (vals[r][c] === "אחוז מכלל ההוצאות") { hr = r; hc = c; break; }
    }
  }
  if (hr < 0) { WARN.push("לא נמצאה טבלת הסיכום לפי סיווג. יש לעדכן את הסכום שם ידנית."); return; }
  const gcol = hc - 3, icol = hc - 1;
  for (let r = hr + 1; r < Math.min(vals.length, hr + 40); r++) {
    const label = String(vals[r][gcol]).trim();
    if (label === 'סה"כ ההוצאות:') break;
    if (label === String(cat).trim()) {
      appendRefToFormula_(sh.getRange(r + 1, icol + 1), ref);
      return;
    }
  }
  WARN.push('הסיווג "' + cat + '" לא קיים בטבלת הסיכום, ולכן הסכום לא נוסף שם. יש להוסיף אותו ידנית.');
}

function appendRefToFormula_(cell, ref) {
  let f = cell.getFormula();
  if (!f) {
    const v = cell.getValue();
    f = (v === "" || v === null) ? "" : "=" + v;
  }
  if (new RegExp("(^|[^A-Z0-9])" + ref + "(?![0-9])").test(f)) return;
  let next;
  if (!f) next = "=" + ref;
  else if (/^=SUM\([^()]*\)$/i.test(f)) next = f.replace(/\)$/, "," + ref + ")");
  else next = "=SUM(" + f.slice(1) + "," + ref + ")";
  cell.setFormula(next);
}

/**
 * בגיליון ההוצאות מקובצות לפי סיווג, וכל קבוצה צבועה בצבע שלה וכוללת לפעמים
 * שורות ריקות צבועות מראש. הרשומה החדשה נכנסת לקבוצה של הסיווג שלה:
 * 1. שורה ריקה בתוך הקבוצה, או שורה ריקה מיד אחריה שצבועה בצבע הקבוצה.
 * 2. אם אין: מוסיפים תאים (רק בעמודות A-F) מיד אחרי השורה האחרונה של הקבוצה.
 * 3. סיווג שאין לו קבוצה בחודש הזה: שורה ריקה אחרונה לפני הסה"כ, או תוספת מעליו.
 * בכל המקרים ההוספה היא בתוך טווח נוסחת הסה"כ, כך שהנוסחה מתרחבת.
 */
function pickExpenseRow_(sh, totalRow, cat) {
  const n = totalRow - EXP_FIRST_ROW;
  if (n <= 0) {
    sh.getRange(EXP_FIRST_ROW, 1, 1, 6).insertCells(SpreadsheetApp.Dimension.ROWS);
    return EXP_FIRST_ROW;
  }
  const rng = sh.getRange(EXP_FIRST_ROW, 1, n, 6);
  const vals = rng.getValues();
  const bgs = rng.getBackgrounds();
  const isBlank = i => String(vals[i][3]).trim() === "";
  const catIdx = [];
  for (let i = 0; i < n; i++) {
    if (!isBlank(i) && String(vals[i][5]).trim() === cat) catIdx.push(i);
  }

  if (catIdx.length) {
    // הקבוצה = הרצף הרציף סביב המופע האחרון של הסיווג (שורות מאותו סיווג
    // או שורות ריקות בצבע הקבוצה). שורה בודדת שסווגה במקום אחר לא נחשבת.
    const last = catIdx[catIdx.length - 1];
    const color = bgs[last][5];
    const inGroup = i => (!isBlank(i) && String(vals[i][5]).trim() === cat) ||
                         (isBlank(i) && bgs[i][5] === color);
    let first = last;
    while (first > 0 && inGroup(first - 1)) first--;
    for (let i = first; i <= last; i++) {
      if (isBlank(i)) return EXP_FIRST_ROW + i;
    }
    for (let i = last + 1; i < n && isBlank(i) && bgs[i][5] === color; i++) {
      return EXP_FIRST_ROW + i;
    }
    // ההוספה חייבת להיות מעל שורת הסה"כ, אחרת הנוסחה לא תכלול אותה
    const row = Math.min(EXP_FIRST_ROW + last + 1, totalRow - 1);
    sh.getRange(row, 1, 1, 6).insertCells(SpreadsheetApp.Dimension.ROWS);
    return row;
  }

  if (isBlank(n - 1)) {
    let i = n - 1;
    while (i > 0 && isBlank(i - 1)) i--;
    return EXP_FIRST_ROW + i;
  }
  const row = totalRow - 1;
  sh.getRange(row, 1, 1, 6).insertCells(SpreadsheetApp.Dimension.ROWS);
  return row;
}

/**
 * מעתיק את העיצוב (צבע רקע, גופן, מסגרות) לשורה החדשה משורה קיימת עם אותו סיווג:
 * קודם בלשונית הנוכחית, ואם אין - בלשוניות של החודשים הקודמים.
 */
function copyCategoryFormat_(sh, row, cat) {
  if (!cat) return;
  const target = sh.getRange(row, 1, 1, 6);
  const sheets = [sh].concat(previousMonthSheets_(sh, 6));
  for (const s of sheets) {
    const last = s.getLastRow();
    if (last < EXP_FIRST_ROW) continue;
    const vals = s.getRange(EXP_FIRST_ROW, 1, last - EXP_FIRST_ROW + 1, 6).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      const r = EXP_FIRST_ROW + i;
      if (s.getSheetId() === sh.getSheetId() && r === row) continue;
      if (String(vals[i][3]).trim() === 'סה"כ') continue;
      if (String(vals[i][5]).trim() === cat && String(vals[i][3]).trim() !== "") {
        s.getRange(r, 1, 1, 6).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        return;
      }
    }
  }
}

function previousMonthSheets_(sh, count) {
  const parts = sh.getName().trim().split(/\s+/);
  let m = MONTHS.indexOf(parts[0]);
  let y = parseInt(parts[1], 10);
  if (m < 0 || isNaN(y)) return [];
  const ss = sh.getParent(), out = [];
  for (let k = 0; k < count; k++) {
    m--; if (m < 0) { m = 11; y--; }
    const yy = String(y).length === 4 ? String(y).slice(2) : String(y).padStart(2, "0");
    const s = ss.getSheetByName(MONTHS[m] + " " + yy) || ss.getSheetByName(MONTHS[m] + " 20" + yy);
    if (s) out.push(s);
  }
  return out;
}

function addIncome_(sh, dateText, src, amount) {
  const last = sh.getLastRow(), lastCol = sh.getLastColumn();
  const vals = sh.getRange(1, 1, Math.min(last, 15), lastCol).getValues();
  let hRow = null, hCol = null;
  for (let r = 0; r < vals.length && !hRow; r++) {
    for (let c = 0; c < vals[r].length; c++) {
      if (vals[r][c] === "שם") { hRow = r + 1; hCol = c + 1; break; }
    }
  }
  if (!hRow) throw new Error('לא נמצאה טבלת ההכנסות (כותרת "שם")');

  const name = String(src).replace(/^משכורת\s+/, "").trim();
  const dCol = hCol - 1, aCol = hCol + 1;

  // שורת הסה"כ של טבלת ההכנסות: "סה"כ" כתוב בעמודת התאריך, משמאל לעמודת השם
  let totalRow = null;
  for (let r = hRow + 1; r <= Math.min(last, hRow + 30); r++) {
    const g = String(sh.getRange(r, dCol).getValue()).trim();
    const h = String(sh.getRange(r, hCol).getValue()).trim();
    if (g === 'סה"כ' || h === 'סה"כ') { totalRow = r; break; }
  }
  if (!totalRow) throw new Error('לא נמצאה שורת סה"כ בטבלת ההכנסות');

  // שורה פנויה בין הכותרת לסה"כ; אם אין, מוסיפים תאים רק בשלוש עמודות הטבלה
  let row = null;
  for (let r = hRow + 1; r < totalRow; r++) {
    if (String(sh.getRange(r, hCol).getValue()).trim() === "" &&
        String(sh.getRange(r, aCol).getValue()).trim() === "") { row = r; break; }
  }
  if (!row) {
    row = totalRow;
    sh.getRange(row, dCol, 1, 3).insertCells(SpreadsheetApp.Dimension.ROWS);
    totalRow++;
  }

  // עיצוב כמו השורה שמעליה בטבלת ההכנסות
  if (row > hRow + 1) {
    sh.getRange(row - 1, dCol, 1, 3)
      .copyTo(sh.getRange(row, dCol, 1, 3), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }
  sh.getRange(row, dCol).setNumberFormat("@");
  sh.getRange(row, dCol, 1, 3).setValues([[dateText, name, amount]]);

  // נוסחת הסה"כ מפרטת תאים ספציפיים, למשל =SUM(I8,I10,I9). מוסיפים את התא החדש.
  const colLetter = sh.getRange(1, aCol).getA1Notation().replace(/[0-9]/g, "");
  appendRefToFormula_(sh.getRange(totalRow, aCol), colLetter + row);
  return row;
}

function page_(ok, msg) {
  const html =
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="font-family:-apple-system,Arial,sans-serif;text-align:center;padding:48px 20px;background:#faf9f5;color:#141413">' +
    '<div style="font-size:48px">' + (ok ? "✅" : "⚠️") + "</div>" +
    '<h2 style="margin:12px 0">' + (ok ? "נרשם בגיליון" : "הרישום נכשל") + "</h2>" +
    '<p style="font-size:16px">' + escape_(msg) + "</p>" +
    '<p style="color:#666;font-size:14px;margin-top:28px">אפשר לסגור את הלשונית ולחזור לאפליקציה.</p>' +
    "</body></html>";
  return HtmlService.createHtmlOutput(html).setTitle((ok ? "נרשם ✓" : "שגיאה") + " · " + SCRIPT_VERSION);
}

function escape_(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
