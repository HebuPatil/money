# Money

A small phone + computer app for logging spending and tracking net worth.
Your Google Sheet is the database; the app is a static website you host for free on GitHub Pages.

```
money-app/
  apps-script/Code.gs   -> the API. Pasted into your Google Sheet's Apps Script.
  docs/                 -> the website. GitHub Pages serves this folder.
    index.html  styles.css  app.js  sw.js  manifest.webmanifest  icons
```

Open `docs/index.html` with no settings and it runs in **demo mode** (data stays on that device), so you can try it before connecting anything.

---

## Part A: Google Sheet + API (about 10 minutes)

1. Go to **sheets.new** and name the sheet `Money`.
2. **Extensions → Apps Script.** Delete the starter code, paste all of `apps-script/Code.gs`, press the save icon.
3. In the toolbar's function menu pick **setup**, press **Run**.
   - Google asks for permission → choose your account → "Google hasn't verified this app" → **Advanced → Go to … (unsafe)** → **Allow**. It's your own script; that warning appears for every personal script.
4. Open **Execution log** at the bottom. Copy the long **token** it printed. Treat it like a password.
   Back in the sheet you'll now see tabs: Transactions, Balances (with your Nov 16 balances), Budget.
5. **Deploy → New deployment** → gear icon → **Web app**.
   - Description: `Money API`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**, then copy the **Web app URL** (ends in `/exec`).
6. Check it: open that URL in a browser tab. You should see `Money API is running`.

"Anyone" only means the URL accepts requests. Without your token, every request is refused, and the sheet itself stays private to your Google account.

## Part B: The website on GitHub Pages (about 10 minutes)

1. On GitHub create a new repository called `money`.
   - Free GitHub Pages needs a **public** repo. That's fine: the code has no data and no token in it.
   - With the GitHub Student Developer Pack (free with your Caltech email) you get Pro, and Pages works on a private repo too.
2. Put the files in it, keeping the `docs` folder:
   ```bash
   cd money-app
   git init && git add . && git commit -m "Money app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/money.git
   git push -u origin main
   ```
   (Or on the repo page: "uploading an existing file", and drag in the `docs` and `apps-script` folders.)
3. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, folder **/docs** → Save.
4. Wait a minute. Your app is at `https://<your-username>.github.io/money/`.
5. Open it, go to **Settings**, paste the Web app URL and token, press **Save & test**. The demo data disappears and your sheet's data loads.

## Part C: Put it on your phone

- **iPhone:** open the URL in Safari → Share → **Add to Home Screen**. Open it from the new icon, go to Settings, paste URL + token.
- **Android:** open in Chrome → ⋮ → **Install app** (or Add to Home screen).

Each device remembers its own URL + token. Easiest way to get the token onto your phone: paste it into a note to yourself, then delete the note.

---

## Day to day

- **Add:** amount → category → Save. Card is the default payment type. A minus sign means a refund.
- **Month:** spent vs budget, per-category bars, on-pace estimate, every transaction. Tap one to edit or delete.
- **Net worth:** update balances about once a week from the Fidelity, First Tech and Discover apps (about a minute). Each update is saved as a snapshot, which draws the trend line.
- **Budget:** edit the Budget tab in the sheet (category, monthly). The app picks it up on the next sync.
- **Offline:** entries save on the device and sync when you're back online. The header shows "2 waiting" until they're in the sheet.

## Changing things

- **Website (`docs/`):** edit, commit, push. The app picks up the new version the next time you open it online.
- **API (`Code.gs`):** after editing, **Deploy → Manage deployments → pencil → Version: New version → Deploy.** The URL doesn't change. Skipping this step is the #1 reason changes "don't work".
- **Token leaked?** Run `rotateToken` in Apps Script, then paste the new token into Settings on each device.

## Troubleshooting

| Message in the app | Fix |
|---|---|
| "…isn't JSON" | The URL is wrong (must end in `/exec`), or access isn't set to **Anyone**. |
| "Wrong token" | Copy the token again from the Execution log (run `setup` again; it reprints the same token). |
| "Can't reach the API" | Offline, or the URL is wrong. Entries are kept and sync later. |
| Code change has no effect | Deploy a **New version** (see above). |

## What the API accepts

POST a JSON body (sent as `text/plain`) with `token`, `action` and fields:

| action | fields |
|---|---|
| `ping` | none |
| `bootstrap` | `since` (YYYY-MM-DD): returns transactions since then, all balances, budget |
| `addTransactions` | `items: [{id, date, amount, category, note, source}]`; the same `id` twice is ignored |
| `updateTransaction` | `id`, `fields` |
| `deleteTransaction` | `id` |
| `addBalances` | `items: [{id, date, account, kind, balance}]`; `kind` is cash, invest, retirement or card (card = amount owed) |
| `deleteBalance` | `id` |
| `setBudget` | `items: [{category, monthly}]` |
