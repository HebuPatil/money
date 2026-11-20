/**
 * Money API: the backend for your money app.
 *
 * Your Google Sheet is the database. This script turns it into a small JSON API
 * that your website calls with POST requests.
 *
 * Setup (once):
 *   1. In your Google Sheet: Extensions -> Apps Script. Replace everything with this file.
 *   2. Pick the function "setup" in the toolbar and press Run. Approve the permissions.
 *   3. Open "Execution log": copy the secret token it prints.
 *   4. Deploy -> New deployment -> type "Web app".
 *        Execute as: Me.   Who has access: Anyone.
 *      Copy the Web app URL (ends in /exec).
 *   5. Paste the URL and token into the app's Settings screen.
 *
 * After you change this code: Deploy -> Manage deployments -> pencil icon ->
 * Version: "New version" -> Deploy. (The URL stays the same.)
 */

const TABS = {
  Transactions: ['id', 'date', 'amount', 'category', 'note', 'source', 'created'],
  Balances: ['id', 'date', 'account', 'kind', 'balance', 'created'],
  Budget: ['category', 'monthly']
};

// Columns stored as plain text so Sheets never turns them into dates.
const TEXT_COLS = {
  Transactions: ['id', 'date', 'created'],
  Balances: ['id', 'date', 'created'],
  Budget: []
};

// Student-year budget (edit the Budget tab any time; the app reads it on every sync).
const SEED_BUDGET = [
  ['Groceries', 200],
  ['Eating out', 150],
  ['Dates', 150],
  ['Coffee & snacks', 50],
  ['Fitness', 100],
  ['Transport', 50],
  ['Shopping', 50],
  ['Personal care', 25],
  ['Subscriptions', 25],
  ['Travel', 0],
  ['Other', 0]
];

// Your balances on Nov 16, 2026. Card balances are stored as the amount you owe (positive).
// kind: cash | invest | retirement | card
const SEED_BALANCES = [
  ['2026-11-16', 'First Tech checking', 'cash', 9143.31],
  ['2026-11-16', 'Fidelity Individual', 'invest', 6449.55],
  ['2026-11-16', 'Fidelity Roth IRA', 'retirement', 7448.41],
  ['2026-11-16', 'Fidelity Traditional IRA', 'retirement', 4810.67],
  ['2026-11-16', 'Discover it card', 'card', 891.69]
];

/* ------------------------------------------------------------------ setup */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    const headers = TABS[name];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    TEXT_COLS[name].forEach(function (col) {
      const c = headers.indexOf(col) + 1;
      sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  const budget = ss.getSheetByName('Budget');
  if (budget.getLastRow() === 1) {
    budget.getRange(2, 1, SEED_BUDGET.length, 2).setValues(SEED_BUDGET);
  }

  const bal = ss.getSheetByName('Balances');
  if (bal.getLastRow() === 1) {
    const now = new Date().toISOString();
    SEED_BALANCES.forEach(function (r) {
      appendRow_('Balances', { id: Utilities.getUuid(), date: r[0], account: r[1], kind: r[2], balance: r[3], created: now });
    });
  }

  // Remove the empty default tab if it's still there.
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  Logger.log('Setup done.\n\nYour secret token (paste it into the app\'s Settings):\n\n' + token);
}

/** Run this if your token ever leaks. Then paste the new one into the app. */
function rotateToken() {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('New token:\n\n' + token);
}

/* ------------------------------------------------------------------ HTTP */

function doGet() {
  return json_({ ok: true, data: 'Money API is running. The app talks to it with POST requests.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Request body is not valid JSON.' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!req || !token || req.token !== token) {
    return json_({ ok: false, error: 'unauthorized' });
  }
  const action = ACTIONS[req.action];
  if (!action) return json_({ ok: false, error: 'Unknown action: ' + req.action });
  try {
    return json_({ ok: true, data: action(req) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

const ACTIONS = {
  ping: function () {
    return { time: new Date().toISOString(), sheet: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
  },

  // Everything the app needs in one call.
  bootstrap: function (req) {
    const since = req.since ? String(req.since) : '';
    return {
      transactions: readAll_('Transactions').filter(function (t) { return !since || String(t.date) >= since; }),
      balances: readAll_('Balances'),
      budget: readAll_('Budget').filter(function (b) { return String(b.category).trim() !== ''; }),
      sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
    };
  },

  addTransactions: function (req) {
    return withLock_(function () {
      return (req.items || []).map(function (t) { return insertIfNew_('Transactions', cleanTx_(t, false)); });
    });
  },

  updateTransaction: function (req) {
    return withLock_(function () { return updateById_('Transactions', req.id, cleanTx_(req.fields || {}, true)); });
  },

  deleteTransaction: function (req) {
    return withLock_(function () { return deleteById_('Transactions', req.id); });
  },

  addBalances: function (req) {
    return withLock_(function () {
      return (req.items || []).map(function (b) { return insertIfNew_('Balances', cleanBal_(b)); });
    });
  },

  deleteBalance: function (req) {
    return withLock_(function () { return deleteById_('Balances', req.id); });
  },

  setBudget: function (req) {
    return withLock_(function () {
      const sh = sheet_('Budget');
      const rows = (req.items || [])
        .filter(function (b) { return String(b.category || '').trim() !== ''; })
        .map(function (b) { return [String(b.category).trim(), Number(b.monthly) || 0]; });
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
      return rows.length;
    });
  }
};

/* ------------------------------------------------------------------ helpers */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() in Apps Script.');
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  return values
    .filter(function (r) { return r.some(function (c) { return c !== ''; }); })
    .map(function (r) {
      const o = {};
      head.forEach(function (k, i) { o[k] = cell_(r[i]); });
      return o;
    });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function findRow_(sh, id) {
  if (!id || sh.getLastRow() < 2) return 0;
  const hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const head = headers_(sh);
  const row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  const range = sh.getRange(row, 1, 1, head.length);
  range.setNumberFormats([head.map(function (k) { return TEXT_COLS[name].indexOf(k) >= 0 ? '@' : 'General'; })]);
  range.setValues([head.map(function (k) { return obj[k] === undefined || obj[k] === null ? '' : obj[k]; })]);
  return obj;
}

// The app makes up an id before sending, so retrying after a dropped connection never duplicates a row.
function insertIfNew_(name, obj) {
  const sh = sheet_(name);
  if (findRow_(sh, obj.id)) return obj;
  return appendRow_(name, obj);
}

function updateById_(name, id, fields) {
  const sh = sheet_(name);
  const row = findRow_(sh, id);
  if (!row) throw new Error('Row not found: ' + id);
  const head = headers_(sh);
  const range = sh.getRange(row, 1, 1, head.length);
  const current = range.getValues()[0];
  const next = head.map(function (k, i) { return k in fields && k !== 'id' ? fields[k] : current[i]; });
  range.setValues([next]);
  const o = {};
  head.forEach(function (k, i) { o[k] = cell_(next[i]); });
  return o;
}

function deleteById_(name, id) {
  const sh = sheet_(name);
  const row = findRow_(sh, id);
  if (row) sh.deleteRow(row);
  return { id: id, deleted: !!row };
}

function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function cleanTx_(t, partial) {
  const o = {};
  if (!partial) {
    o.id = String(t.id || Utilities.getUuid());
    o.created = new Date().toISOString();
  }
  if (!partial || 'date' in t) {
    if (!isDate_(t.date)) throw new Error('Date must look like 2026-11-19.');
    o.date = String(t.date);
  }
  if (!partial || 'amount' in t) {
    const a = Number(t.amount);
    if (!isFinite(a)) throw new Error('Amount must be a number.');
    o.amount = Math.round(a * 100) / 100;
  }
  if (!partial || 'category' in t) o.category = String(t.category || 'Other').slice(0, 60);
  if (!partial || 'note' in t) o.note = String(t.note || '').slice(0, 200);
  if (!partial || 'source' in t) o.source = String(t.source || 'card').slice(0, 20);
  return o;
}

function cleanBal_(b) {
  if (!isDate_(b.date)) throw new Error('Date must look like 2026-11-19.');
  const v = Number(b.balance);
  if (!isFinite(v)) throw new Error('Balance must be a number.');
  return {
    id: String(b.id || Utilities.getUuid()),
    date: String(b.date),
    account: String(b.account || '').slice(0, 60),
    kind: ['cash', 'invest', 'retirement', 'card'].indexOf(b.kind) >= 0 ? b.kind : 'cash',
    balance: Math.round(v * 100) / 100,
    created: new Date().toISOString()
  };
}
