# K9 פיננסים — שרת

דשבורד ההכנסות וההוצאות של הבית, כאתר עצמאי שרץ על Google Cloud Run.

> ⚠️ **הריפו הזה פרטי ויישאר פרטי.** `public/index.html` מכיל נתונים פיננסיים אמיתיים של המשפחה. אין להפוך אותו לציבורי.

## מה יש כאן

| קובץ | תפקיד |
|---|---|
| `public/index.html` | האפליקציה עצמה (אותה אפליקציה שהייתה ב-claude.ai) |
| `public/k9-bridge.js` | מחבר את האפליקציה לשרת במקום לחיבורים של claude.ai |
| `server.js` | השרת: סיסמת כניסה, קריאת הגיליון מ-Google, סריקת קבלות עם Claude |
| `Dockerfile` | הוראות הבנייה ל-Cloud Run |
| `apps-script/Code.gs` | ה-Apps Script שרושם רשומות חדשות לגיליון (פרוס בנפרד ב-Google Apps Script, לא חלק מהשרת) |

**איך זה עובד:** הדפדפן פונה לשרת. השרת קורא את הגיליון המשפחתי דרך **חשבון שירות** (משתמש רובוט של גוגל שהגיליון משותף איתו לצפייה בלבד), ושולח תמונות קבלות ל-Claude API לפענוח. רשומות חדשות נשלחות לגיליון דרך ה-Apps Script, כמו קודם.

## משתני סביבה

| משתנה | חובה | מה זה |
|---|---|---|
| `APP_PASSWORD` | כן | סיסמת הכניסה המשפחתית |
| `SESSION_SECRET` | כן | מחרוזת אקראית ארוכה (שומרת על ההתחברות בין הפעלות) |
| `SHEET_FILE_ID` | לא | מזהה הגיליון (ברירת מחדל: הגיליון הנוכחי) |
| `ANTHROPIC_API_KEY` | לא | מפתח ל-Claude API. בלעדיו סריקת קבלות כבויה, כל השאר עובד |
| `CLAUDE_MODEL` | לא | ברירת מחדל `claude-sonnet-5-5` |

---

## העלאה ל-Google Cloud Run — צעד אחר צעד

הכול נעשה מ-**Cloud Shell** (הטרמינל המובנה של Google Cloud, בלי להתקין כלום):
נכנסים ל-[console.cloud.google.com](https://console.cloud.google.com) ← לוחצים על אייקון `>_` למעלה.

### 1. פרויקט ו-APIs

```bash
# מחליפים k9-finance-tomer בשם ייחודי משלכם
gcloud projects create k9-finance-tomer --name="K9 Finance"
gcloud config set project k9-finance-tomer
```

מחברים חשבון חיוב לפרויקט (חובה גם כשהשימוש בחינם): Billing ← Link a billing account.

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com drive.googleapis.com secretmanager.googleapis.com
```

### 2. חשבון השירות

```bash
gcloud iam service-accounts create k9-sheets --display-name="K9 sheet reader"
SA=k9-sheets@$(gcloud config get-value project).iam.gserviceaccount.com
echo $SA
```

**שתפו את הגיליון המשפחתי עם הכתובת שהודפסה** (כפתור "שיתוף" בגיליון ← מדביקים את הכתובת ← הרשאת **צפייה** ← מבטלים את "שליחת הודעה").

### 3. סודות (סיסמה ומפתחות)

```bash
printf 'הסיסמה-שבחרתם' | gcloud secrets create k9-app-password --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create k9-session-secret --data-file=-
# אופציונלי, לסריקת קבלות (מפתח מ-console.anthropic.com):
printf 'sk-ant-...' | gcloud secrets create k9-anthropic-key --data-file=-

for s in k9-app-password k9-session-secret k9-anthropic-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
# (אם לא יצרתם את k9-anthropic-key, השגיאה עליו בלולאה תקינה)
```

### 4. הורדת הקוד והעלאה

```bash
git clone https://github.com/<המשתמש-שלכם>/k9-finance.git && cd k9-finance

gcloud run deploy k9-finance --source . \
  --region me-west1 \
  --service-account $SA \
  --allow-unauthenticated \
  --max-instances 1 --memory 512Mi \
  --set-secrets APP_PASSWORD=k9-app-password:latest,SESSION_SECRET=k9-session-secret:latest,ANTHROPIC_API_KEY=k9-anthropic-key:latest
```

(בלי סריקת קבלות: מורידים את `,ANTHROPIC_API_KEY=...` מהשורה האחרונה.)

בסוף מודפסת כתובת בסגנון `https://k9-finance-xxxx.me-west1.run.app` — זה האתר.
`me-west1` הוא אזור תל אביב. `--allow-unauthenticated` אומר שגוגל לא חוסם את הכניסה; את ההגנה עושה סיסמת האפליקציה.

### 5. עדכונים בהמשך

אחרי כל שינוי בקוד: `git pull` ואז אותה פקודת `gcloud run deploy` (סודות וחשבון השירות כבר שמורים, אפשר לקצר ל-`gcloud run deploy k9-finance --source . --region me-west1`).

רוצים שזה יקרה אוטומטית? ב-Cloud Run ← השירות ← **Set up continuous deployment** ← מחברים את ריפו ה-GitHub.

---

## התקנה כאפליקציה

- **טלפון (אנדרואיד/אייפון):** פותחים את הכתובת ← תפריט ← "הוספה למסך הבית".
- **מחשב Windows:** פותחים ב-Chrome או Edge ← אייקון ההתקנה בשורת הכתובת ("התקנת אפליקציה").

## הרצה מקומית (לפיתוח)

```bash
npm install
cp .env.example .env    # וממלאים ערכים
# מורידים מפתח JSON לחשבון השירות ושומרים כ-service-account.json (לא נכנס ל-git)
node --env-file=.env server.js
```

ואז `http://localhost:8080`.

## עלויות

Cloud Run בשימוש משפחתי נשאר בתוך המכסה החינמית. סריקת קבלה ב-Claude API עולה בערך סנט או שניים לסריקה.
