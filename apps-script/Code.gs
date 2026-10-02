/**
 * K9 פיננסים — רישום רשומה לגיליון
 *
 * האפליקציה פותחת את כתובת ה-Web App הזו בלשונית חדשה, עם פרטי הרשומה
 * בכתובת. הסקריפט מוסיף את השורה ללשונית החודש המתאימה ומציג אישור.
 *
 * פריסה: Deploy → Manage deployments → ✏️ → Version: New version
 *        Execute as: Me · Who has access: Anyone
 */

const TOKEN = "k9-eSxNZUqsW__u2KnNLMp38a_v";
const SHEET_ID = "1gLA2t9RToM5N-LhdSSqEufR3pGdTN8ouT8Yu_Pa0o3U";

const MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני",
                "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

// עמודות טבלת ההוצאות: A תאריך, B אמצעי תשלום, C תשלומים, D תיאור, E סכום, F קטגוריה
const EXP_FIRST_ROW = 5;
const COL_DESC = 4;

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.token !== TOKEN) throw new Error("אין הרשאה (טוקן שגוי)");

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
        where = addExpense_(sh, dateText, p.pay || "", p.desc, amount, p.cat || "");
      }

      if (p.id) props.setProperty("done_" + p.id, "1");
      return page_(true, "נרשם בלשונית \"" + sh.getName() + "\" בשורה " + where + ".");
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return page_(false, err.message);
  }
}

function addExpense_(sh, dateText, pay, desc, amount, cat) {
  const last = sh.getLastRow();
  let totalRow = null;
  const dVals = sh.getRange(EXP_FIRST_ROW, COL_DESC, Math.max(1, last - EXP_FIRST_ROW + 1), 1).getValues();
  for (let i = 0; i < dVals.length; i++) {
    if (String(dVals[i][0]).trim() === 'סה"כ') { totalRow = EXP_FIRST_ROW + i; break; }
  }
  if (!totalRow) throw new Error('לא נמצאה שורת סה"כ בטבלת ההוצאות');

  // שורה ריקה ראשונה לפני שורת הסה"כ
  let row = null;
  for (let r = EXP_FIRST_ROW; r < totalRow; r++) {
    if (String(dVals[r - EXP_FIRST_ROW][0]).trim() === "") { row = r; break; }
  }
  // אין מקום: מוסיפים תאים רק בעמודות A-F מעל השורה האחרונה, כדי שנוסחת הסה"כ תתרחב
  if (!row) {
    row = Math.max(EXP_FIRST_ROW, totalRow - 1);
    sh.getRange(row, 1, 1, 6).insertCells(SpreadsheetApp.Dimension.ROWS);
  }
  sh.getRange(row, 1).setNumberFormat("@");
  sh.getRange(row, 1, 1, 6).setValues([[dateText, pay, "לא", desc, amount, cat]]);
  return row;
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
  let row = hRow + 1;
  while (row <= last) {
    const v = String(sh.getRange(row, hCol).getValue()).trim();
    if (v === "" ) break;
    if (v === 'סה"כ') {
      // אין שורה פנויה: מוסיפים תאים בשלוש עמודות הטבלה מעל השורה האחרונה
      row = Math.max(hRow + 1, row - 1);
      sh.getRange(row, hCol - 1, 1, 3).insertCells(SpreadsheetApp.Dimension.ROWS);
      break;
    }
    row++;
  }
  sh.getRange(row, hCol - 1).setNumberFormat("@");
  sh.getRange(row, hCol - 1, 1, 3).setValues([[dateText, name, amount]]);
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
  return HtmlService.createHtmlOutput(html).setTitle(ok ? "נרשם ✓" : "שגיאה");
}

function escape_(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
