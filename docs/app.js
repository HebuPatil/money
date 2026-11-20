/* Money: log spending, see this month, track net worth.
 * Data lives in your Google Sheet (via the Apps Script API). This device keeps a copy,
 * so the app opens instantly and works offline; changes queue up and sync when online.
 * With no API URL set, the app runs in demo mode on this device only.
 */
(function () {
  'use strict';

  var K = { cfg: 'money.cfg', cache: 'money.cache', queue: 'money.queue', demo: 'money.demo', last: 'money.lastSync' };
  var SOURCES = [['card', 'Card'], ['venmo', 'Venmo'], ['cash', 'Cash'], ['debit', 'Debit']];
  var KINDS = [['cash', 'Cash'], ['invest', 'Investments'], ['retirement', 'Retirement'], ['card', 'Credit cards']];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var SEED_BUDGET = [['Groceries', 200], ['Eating out', 150], ['Dates', 150], ['Coffee & snacks', 50], ['Fitness', 100], ['Transport', 50], ['Shopping', 50], ['Personal care', 25], ['Subscriptions', 25], ['Travel', 0], ['Other', 0]];
  var SEED_BALANCES = [['2026-11-16', 'First Tech checking', 'cash', 9143.31], ['2026-11-16', 'Fidelity Individual', 'invest', 6449.55], ['2026-11-16', 'Fidelity Roth IRA', 'retirement', 7448.41], ['2026-11-16', 'Fidelity Traditional IRA', 'retirement', 4810.67], ['2026-11-16', 'Discover it card', 'card', 891.69]];

  /* ---------- small helpers ---------- */
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function shiftMonth(ym, k) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + pad(m); }
  function monthName(ym) { return MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4); }
  function daysInMonth(ym) { return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }
  function shortDate(s) { if (!s) return ''; return MONTHS[+s.slice(5, 7) - 1].slice(0, 3) + ' ' + (+s.slice(8, 10)); }
  function dayLabel(s) {
    var t = today();
    if (s === t) return 'Today';
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (s === y.getFullYear() + '-' + pad(y.getMonth() + 1) + '-' + pad(y.getDate())) return 'Yesterday';
    var d = new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ', ' + shortDate(s);
  }
  function num(x) { x = +x; return isFinite(x) ? x : 0; }
  function money(x, cents) {
    x = num(x);
    var s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return (x < 0 ? '−$' : '$') + s;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function parseAmount(s) { var t = String(s || '').replace(/[$,\s]/g, ''); if (!/^-?\d*\.?\d+$/.test(t) && !/^-?\d+\.$/.test(t)) return NaN; return Math.round(parseFloat(t) * 100) / 100; }
  function ago(iso) {
    if (!iso) return 'never';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function $(id) { return document.getElementById(id); }

  /* ---------- state ---------- */
  var S = {
    cfg: load(K.cfg, { apiUrl: '', token: '' }),
    data: load(K.cache, null),
    queue: load(K.queue, []),
    lastSync: load(K.last, null),
    month: today().slice(0, 7),
    syncing: false,
    error: '',
    draft: { amount: '', category: '', note: '', source: 'card', date: today() }
  };
  function isDemo() { return !S.cfg.apiUrl; }
  function emptyData() { return { transactions: [], balances: [], budget: [] }; }

  /* ---------- local copy of the server logic (used for instant updates and demo mode) ---------- */
  function applyLocal(d, action, p) {
    var now = new Date().toISOString();
    if (action === 'addTransactions') (p.items || []).forEach(function (t) { if (!d.transactions.some(function (x) { return x.id === t.id; })) d.transactions.push(Object.assign({ created: now }, t)); });
    else if (action === 'updateTransaction') d.transactions.forEach(function (t) { if (t.id === p.id) Object.assign(t, p.fields); });
    else if (action === 'deleteTransaction') d.transactions = d.transactions.filter(function (t) { return t.id !== p.id; });
    else if (action === 'addBalances') (p.items || []).forEach(function (b) { if (!d.balances.some(function (x) { return x.id === b.id; })) d.balances.push(Object.assign({ created: now }, b)); });
    else if (action === 'deleteBalance') d.balances = d.balances.filter(function (b) { return b.id !== p.id; });
    else if (action === 'setBudget') d.budget = (p.items || []).map(function (b) { return { category: b.category, monthly: num(b.monthly) }; });
    return d;
  }

  function demoStore() {
    var d = load(K.demo, null);
    if (!d) {
      var ym = today().slice(0, 7), stamp = new Date().toISOString();
      d = {
        budget: SEED_BUDGET.map(function (b) { return { category: b[0], monthly: b[1] }; }),
        balances: SEED_BALANCES.map(function (b) { return { id: uid(), date: b[0], account: b[1], kind: b[2], balance: b[3], created: stamp }; }),
        transactions: [
          [ym + '-02', 46, 'Groceries', "Trader Joe's", 'card'], [ym + '-05', 94, 'Fitness', 'Climbing', 'card'], [ym + '-08', 52, 'Dates', 'Dinner + ice cream', 'card'],
          [ym + '-11', 25, 'Eating out', 'Pizza', 'venmo'], [ym + '-13', 10.49, 'Eating out', 'In-N-Out', 'card'], [ym + '-14', 7.95, 'Coffee & snacks', 'Tea', 'card'],
          [ym + '-15', 35.06, 'Eating out', 'Poke', 'card'], [ym + '-15', 55.36, 'Shopping', 'Target', 'card'], [ym + '-16', 18.11, 'Groceries', "Trader Joe's", 'card']
        ].filter(function (r) { return r[0] <= today(); }).map(function (r) { return { id: uid(), date: r[0], amount: r[1], category: r[2], note: r[3], source: r[4], created: stamp }; })
      };
      save(K.demo, d);
    }
    return d;
  }
  function demoCall(action, p) {
    return new Promise(function (res) { setTimeout(res, 120); }).then(function () {
      var d = demoStore();
      if (action === 'ping') return { time: new Date().toISOString(), sheet: '' };
      if (action === 'bootstrap') {
        var out = JSON.parse(JSON.stringify(d));
        out.transactions = out.transactions.filter(function (t) { return !p.since || t.date >= p.since; });
        out.sheetUrl = '';
        return out;
      }
      applyLocal(d, action, p); save(K.demo, d); return true;
    });
  }

  /* ---------- talking to the Apps Script API ---------- */
  function call(action, payload) {
    payload = payload || {};
    if (isDemo()) return demoCall(action, payload);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 25000);
    return fetch(S.cfg.apiUrl, {
      method: 'POST',
      // text/plain keeps this a "simple" request, which Apps Script can answer (it can't handle CORS preflights).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: S.cfg.token, action: action }, payload)),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { return res.text(); }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (e) { throw new Error('The API sent back something that isn\'t JSON. Check the URL ends in /exec and access is set to "Anyone".'); }
      if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'Wrong token. Copy it again from the Apps Script execution log.' : j.error);
      return j.data;
    }).finally(function () { clearTimeout(timer); });
  }
  function explain(e) {
    if (e && e.name === 'AbortError') return 'The API took too long. Your entries are saved on this device and will sync later.';
    if (e instanceof TypeError) return 'Can\'t reach the API (offline?). Your entries are saved on this device and will sync later.';
    return (e && e.message) || 'Something went wrong.';
  }

  var syncing = null, syncAgain = false;
  function sync() {
    if (syncing) { syncAgain = true; return syncing; }
    S.syncing = true; paintSync();
    syncing = (function flush() {
      if (!S.queue.length) return Promise.resolve();
      return call(S.queue[0].action, S.queue[0].payload).then(function () { S.queue.shift(); save(K.queue, S.queue); return flush(); });
    })().then(function () {
      var y = +today().slice(0, 4);
      return call('bootstrap', { since: (y - 1) + '-01-01' });
    }).then(function (d) {
      S.queue.forEach(function (op) { applyLocal(d, op.action, op.payload); });
      S.data = d; save(K.cache, d);
      S.error = ''; S.lastSync = new Date().toISOString(); save(K.last, S.lastSync);
    }).catch(function (e) { S.error = explain(e); }).then(function () {
      S.syncing = false; syncing = null; render();
      if (syncAgain) { syncAgain = false; sync(); }
    });
    return syncing;
  }
  function mutate(action, payload, msg) {
    if (!S.data) S.data = emptyData();
    applyLocal(S.data, action, payload); save(K.cache, S.data);
    S.queue.push({ action: action, payload: payload }); save(K.queue, S.queue);
    if (msg) toast(msg);
    render(); sync();
  }

  /* ---------- derived numbers ---------- */
  function data() { return S.data || emptyData(); }
  function budgetCats() { var b = data().budget.filter(function (x) { return String(x.category).trim(); }); return b.length ? b : SEED_BUDGET.map(function (x) { return { category: x[0], monthly: x[1] }; }); }
  function txIn(prefix) { return data().transactions.filter(function (t) { return String(t.date).indexOf(prefix) === 0; }); }
  function total(list) { return list.reduce(function (a, t) { return a + num(t.amount); }, 0); }
  function latestBalances(upTo) {
    var by = {};
    data().balances.forEach(function (b) {
      if (upTo && b.date > upTo) return;
      var cur = by[b.account];
      if (!cur || b.date > cur.date || (b.date === cur.date && String(b.created) > String(cur.created))) by[b.account] = b;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function netWorth(list) { return list.reduce(function (a, b) { return a + (b.kind === 'card' ? -num(b.balance) : num(b.balance)); }, 0); }
  function nwHistory() {
    var dates = Array.from(new Set(data().balances.map(function (b) { return b.date; }))).sort();
    return dates.map(function (d) { return { date: d, nw: netWorth(latestBalances(d)) }; });
  }
  function pendingIds() {
    var ids = {};
    S.queue.forEach(function (op) { (op.payload.items || []).forEach(function (t) { ids[t.id] = 1; }); if (op.payload.id) ids[op.payload.id] = 1; });
    return ids;
  }

  /* ---------- views ---------- */
  function viewAdd() {
    var d = S.draft, cats = budgetCats();
    var recent = data().transactions.slice().sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); }).slice(0, 5);
    var pend = pendingIds();
    return '' +
      '<section class="card">' +
        '<label class="amount"><span>$</span><input id="amt" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" value="' + esc(d.amount) + '" aria-label="Amount"></label>' +
        '<div class="sub" style="text-align:center">Refund? Put a minus sign in front.</div>' +
      '</section>' +
      '<section class="card"><h2>Category</h2><div class="chips" role="group" aria-label="Category">' +
        cats.map(function (c) { return '<button type="button" class="chip" data-cat="' + esc(c.category) + '" aria-pressed="' + (d.category === c.category) + '">' + esc(c.category) + '</button>'; }).join('') +
      '</div></section>' +
      '<section class="card" style="display:grid;gap:12px">' +
        '<div class="field"><span class="label">Paid with</span><div class="seg" role="group" aria-label="Paid with">' +
          SOURCES.map(function (s) { return '<button type="button" data-src="' + s[0] + '" aria-pressed="' + (d.source === s[0]) + '">' + s[1] + '</button>'; }).join('') +
        '</div></div>' +
        '<div class="two">' +
          '<label class="field"><span class="label">Date</span><input class="input" type="date" id="date" value="' + esc(d.date) + '"></label>' +
          '<label class="field"><span class="label">Note</span><input class="input" id="note" placeholder="Optional" autocomplete="off" value="' + esc(d.note) + '"></label>' +
        '</div>' +
      '</section>' +
      '<button type="button" class="btn btn-primary" id="save"' + (canSave() ? '' : ' disabled') + '>Save</button>' +
      (recent.length ? '<section class="card"><h2>Recently added</h2><div class="list">' + recent.map(function (t) { return txRow(t, pend); }).join('') + '</div></section>' : '');
  }
  function canSave() { return isFinite(parseAmount(S.draft.amount)) && parseAmount(S.draft.amount) !== 0 && !!S.draft.category; }
  function txRow(t, pend) {
    return '<button type="button" class="tx' + (pend[t.id] ? ' pending' : '') + '" data-tx="' + esc(t.id) + '">' +
      '<span class="c">' + esc(t.category) + '</span><span class="a' + (num(t.amount) < 0 ? ' pos' : '') + '">' + money(t.amount, true) + '</span>' +
      '<span class="n">' + esc([t.note, (SOURCES.filter(function (s) { return s[0] === t.source; })[0] || [0, t.source])[1], shortDate(t.date)].filter(Boolean).join(' · ')) + '</span></button>';
  }

  function viewMonth() {
    var ym = S.month, txs = txIn(ym), spent = total(txs), cats = budgetCats();
    var budget = cats.reduce(function (a, c) { return a + num(c.monthly); }, 0);
    var isNow = ym === today().slice(0, 7), dim = daysInMonth(ym);
    var day = isNow ? +today().slice(8, 10) : dim;
    var pace = isNow && day > 0 ? spent / day * dim : spent;
    var by = {}; txs.forEach(function (t) { by[t.category] = (by[t.category] || 0) + num(t.amount); });
    var rows = cats.map(function (c) { return { name: c.category, budget: num(c.monthly), spent: by[c.category] || 0 }; });
    Object.keys(by).forEach(function (k) { if (!cats.some(function (c) { return c.category === k; })) rows.push({ name: k, budget: 0, spent: by[k] }); });
    rows = rows.filter(function (r) { return r.spent !== 0 || r.budget > 0; }).sort(function (a, b) { return b.spent - a.spent; });
    var bySrc = {}; txs.forEach(function (t) { bySrc[t.source] = (bySrc[t.source] || 0) + num(t.amount); });
    var y = ym.slice(0, 4), yTx = txIn(y), ytd = total(yTx);
    var firstM = yTx.reduce(function (a, t) { return Math.min(a, +String(t.date).slice(5, 7)); }, 12);
    var lastM = (y === today().slice(0, 4)) ? +today().slice(5, 7) : 12;
    var monthsSoFar = Math.max(1, lastM - Math.min(firstM, lastM) + 1);
    var over = spent > budget && budget > 0;
    var pend = pendingIds();
    var days = {}; txs.forEach(function (t) { (days[t.date] = days[t.date] || []).push(t); });
    var dayKeys = Object.keys(days).sort().reverse();

    return '' +
      '<div class="monthnav"><button type="button" data-month="-1" aria-label="Previous month">‹</button><h2>' + monthName(ym) + '</h2><button type="button" data-month="1" aria-label="Next month"' + (isNow ? ' disabled style="opacity:.35"' : '') + '>›</button></div>' +
      '<section class="card">' +
        '<div class="label">Spent</div><div class="big">' + money(spent, true) + '</div>' +
        '<div class="sub">of ' + money(budget) + ' budget</div>' +
        '<div class="meter' + (over ? ' over' : '') + '"><span style="width:' + (budget > 0 ? Math.min(100, spent / budget * 100) : 0).toFixed(1) + '%"></span></div>' +
        '<div class="row"><span class="' + (over ? 'neg' : 'pos') + '" style="font-weight:650">' + (budget > 0 ? (over ? 'Over by ' + money(spent - budget, true) : money(budget - spent, true) + ' left') : 'No budget set') + '</span>' +
        (isNow ? '<span class="sub">On pace for ' + money(pace) + '</span>' : '') + '</div>' +
        '<div class="sub" style="margin-top:8px">' + SOURCES.filter(function (s) { return bySrc[s[0]]; }).map(function (s) { return s[1] + ' ' + money(bySrc[s[0]]); }).join(' · ') + '</div>' +
      '</section>' +
      '<section class="card"><h2>By category</h2><div class="cats">' + (rows.length ? rows.map(function (r) {
        var o = r.budget > 0 && r.spent > r.budget;
        return '<div class="cat"><div class="row"><span>' + esc(r.name) + (o ? '<span class="pill over">over</span>' : '') + '</span><span class="amt">' + money(r.spent) + (r.budget > 0 ? ' <span class="of">/ ' + money(r.budget) + '</span>' : '') + '</span></div>' +
          '<div class="meter' + (o ? ' over' : '') + '"><span style="width:' + (r.budget > 0 ? Math.min(100, r.spent / r.budget * 100) : (r.spent > 0 ? 100 : 0)).toFixed(1) + '%"></span></div></div>';
      }).join('') : '<div class="empty">Nothing logged this month yet.</div>') + '</div></section>' +
      '<section class="card"><div class="row"><span class="label">' + y + ' so far</span><span class="mid">' + money(ytd) + '</span></div><div class="sub">' + money(ytd / monthsSoFar) + ' per month on average over ' + monthsSoFar + (monthsSoFar === 1 ? ' month' : ' months') + ' logged</div></section>' +
      '<section class="card"><h2>Transactions</h2><div class="list">' + (dayKeys.length ? dayKeys.map(function (dk) {
        return '<div class="day">' + dayLabel(dk) + '</div>' + days[dk].map(function (t) { return txRow(t, pend); }).join('');
      }).join('') : '<div class="empty">No transactions.</div>') + '</div></section>';
  }

  function viewWorth() {
    var latest = latestBalances(), nw = netWorth(latest), hist = nwHistory();
    var prev = hist.length > 1 ? hist[hist.length - 2].nw : null;
    var asOf = latest.reduce(function (a, b) { return b.date > a ? b.date : a; }, '');
    var cardSpend = total(txIn(today().slice(0, 7)).filter(function (t) { return t.source === 'card'; }));
    var cards = latest.filter(function (b) { return b.kind === 'card'; });
    var groups = KINDS.map(function (k) {
      var list = latest.filter(function (b) { return b.kind === k[0]; });
      if (!list.length) return '';
      return '<div class="group-h">' + k[1] + '</div><div class="accts">' + list.map(function (b) {
        return '<div class="acct"><span class="n">' + esc(b.account) + '</span><span class="v' + (b.kind === 'card' ? ' neg' : '') + '">' + (b.kind === 'card' ? '−' : '') + money(Math.abs(num(b.balance)), true) + '</span><span class="d">Updated ' + shortDate(b.date) + '</span></div>';
      }).join('') + '</div>';
    }).join('');
    return '' +
      '<section class="card"><div class="label">Net worth</div><div class="big">' + money(nw) + '</div>' +
        '<div class="sub">' + (asOf ? 'As of ' + shortDate(asOf) : 'Add your balances to start') + (prev !== null ? ' · <span class="' + (nw - prev >= 0 ? 'pos' : 'neg') + '">' + (nw - prev >= 0 ? '+' : '') + money(nw - prev) + '</span> since last update' : '') + '</div>' +
        spark(hist) + '</section>' +
      '<section class="card"><h2>Credit card</h2>' +
        '<div class="row"><span>Owed (last update)</span><span class="mid neg">' + money(cards.reduce(function (a, b) { return a + num(b.balance); }, 0), true) + '</span></div>' +
        '<div class="row" style="margin-top:6px"><span>Logged on card this month</span><span class="mid">' + money(cardSpend, true) + '</span></div>' +
        '<div class="sub" style="margin-top:6px">Pay the full statement balance every month.</div></section>' +
      '<section class="card"><div class="row"><h2 style="margin:0">Accounts</h2><button type="button" class="btn btn-sm" id="upd-bal">Update balances</button></div>' + (groups || '<div class="empty">No accounts yet.</div>') + '</section>';
  }
  function spark(h) {
    if (!h.length) return '';
    var W = 320, H = 90, P = 6;
    var vals = h.map(function (p) { return p.nw; }), min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max === min) { max += 1; min -= 1; }
    var t0 = new Date(h[0].date).getTime(), t1 = new Date(h[h.length - 1].date).getTime(), span = Math.max(1, t1 - t0);
    var pts = h.map(function (p) {
      var x = h.length === 1 ? W / 2 : P + (new Date(p.date).getTime() - t0) / span * (W - 2 * P);
      var y = P + (1 - (p.nw - min) / (max - min)) * (H - 22 - P);
      return [x, y];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - 16) + ' L' + pts[0][0].toFixed(1) + ' ' + (H - 16) + ' Z';
    var last = pts[pts.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Net worth over time">' +
      '<line class="gl" x1="0" x2="' + W + '" y1="' + (H - 16) + '" y2="' + (H - 16) + '"/>' +
      (h.length > 1 ? '<path class="ar" d="' + area + '"/><path class="ln" d="' + line + '"/>' : '') +
      '<circle class="dt" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4"/>' +
      '<text x="' + P + '" y="' + (H - 3) + '">' + shortDate(h[0].date) + '</text>' +
      (h.length > 1 ? '<text x="' + (W - P) + '" y="' + (H - 3) + '" text-anchor="end">' + shortDate(h[h.length - 1].date) + '</text>' : '') +
      '</svg>';
  }

  function viewSettings() {
    var url = (S.data && S.data.sheetUrl) || '';
    return '' +
      '<section class="card" style="display:grid;gap:12px"><h2>Connection</h2>' +
        (isDemo() ? '<div class="note-box">Demo mode: entries stay on this device only. Paste your Web app URL and token to use your Google Sheet.</div>' : '') +
        '<label class="field"><span class="label">Web app URL</span><input class="input" id="cfg-url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false" value="' + esc(S.cfg.apiUrl) + '"></label>' +
        '<label class="field"><span class="label">Secret token</span><input class="input" id="cfg-token" type="password" autocomplete="off" spellcheck="false" value="' + esc(S.cfg.token) + '"></label>' +
        '<div class="two"><button type="button" class="btn" id="cfg-save">Save & test</button><button type="button" class="btn" id="cfg-show">Show token</button></div>' +
        (S.error ? '<div class="err-box">' + esc(S.error) + '</div>' : '') +
        '<div class="sub">Last sync: ' + ago(S.lastSync) + ' · Waiting to sync: ' + S.queue.length + '</div>' +
        (url ? '<a class="linkbtn" href="' + esc(url) + '" target="_blank" rel="noopener">Open your Google Sheet ↗</a>' : '') +
      '</section>' +
      '<section class="card" style="display:grid;gap:10px"><h2>Budget & categories</h2><div class="sub">Edit the Budget tab in your Google Sheet (category, monthly amount). The app picks up changes on the next sync.</div></section>' +
      '<section class="card" style="display:grid;gap:10px"><h2>This device</h2>' +
        '<button type="button" class="btn" id="cfg-clear">Clear the copy on this device</button>' +
        (isDemo() ? '<button type="button" class="btn" id="cfg-demo">Reset demo data</button>' : '') +
        '<div class="sub">Your Google Sheet isn\'t touched. Unsynced entries are kept.</div></section>';
  }

  /* ---------- bottom sheets ---------- */
  function openSheet(html) { var el = $('sheet'); el.innerHTML = '<div class="panel" role="dialog" aria-modal="true">' + html + '</div>'; el.hidden = false; var f = el.querySelector('input,select,button'); if (f) f.focus(); }
  function closeSheet() { var el = $('sheet'); el.hidden = true; el.innerHTML = ''; }

  function openEdit(id) {
    var t = data().transactions.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var cats = budgetCats().map(function (c) { return c.category; });
    if (cats.indexOf(t.category) < 0) cats.push(t.category);
    openSheet('<h2>Edit transaction</h2>' +
      '<div class="two"><label class="field"><span class="label">Amount</span><input class="input" id="e-amt" inputmode="decimal" value="' + esc(t.amount) + '"></label>' +
      '<label class="field"><span class="label">Date</span><input class="input" type="date" id="e-date" value="' + esc(t.date) + '"></label></div>' +
      '<div class="two"><label class="field"><span class="label">Category</span><select class="input" id="e-cat">' + cats.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span class="label">Paid with</span><select class="input" id="e-src">' + SOURCES.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === t.source ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="field"><span class="label">Note</span><input class="input" id="e-note" value="' + esc(t.note) + '"></label>' +
      '<div id="e-err"></div>' +
      '<button type="button" class="btn btn-primary" data-act="tx-update" data-id="' + esc(t.id) + '">Save changes</button>' +
      '<div class="two"><button type="button" class="btn btn-danger" data-act="tx-delete" data-id="' + esc(t.id) + '">Delete</button><button type="button" class="btn" data-act="close">Cancel</button></div>');
  }

  function openBalances() {
    var latest = latestBalances();
    var order = {}; KINDS.forEach(function (k, i) { order[k[0]] = i; });
    latest.sort(function (a, b) { return order[a.kind] - order[b.kind]; });
    openSheet('<h2>Update balances</h2><div class="sub">Type today\'s balance from each app. Credit cards: the amount you owe.</div>' +
      '<label class="field"><span class="label">As of</span><input class="input" type="date" id="b-date" value="' + today() + '"></label>' +
      latest.map(function (b, i) {
        return '<label class="field"><span class="label">' + esc(b.account) + ' <span class="sub">(' + (KINDS.filter(function (k) { return k[0] === b.kind; })[0] || [0, b.kind])[1].toLowerCase() + ', last ' + money(b.balance, true) + ')</span></span>' +
          '<input class="input" inputmode="decimal" data-bal="' + i + '" data-account="' + esc(b.account) + '" data-kind="' + esc(b.kind) + '" value="' + esc(b.balance) + '"></label>';
      }).join('') +
      '<details><summary class="linkbtn">+ Add another account</summary><div style="display:grid;gap:10px;margin-top:10px">' +
        '<label class="field"><span class="label">Account name</span><input class="input" id="n-name" placeholder="e.g. Two Sigma 401(k)"></label>' +
        '<div class="two"><label class="field"><span class="label">Type</span><select class="input" id="n-kind">' + KINDS.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span class="label">Balance</span><input class="input" id="n-bal" inputmode="decimal"></label></div></div></details>' +
      '<div id="b-err"></div>' +
      '<button type="button" class="btn btn-primary" data-act="bal-save">Save balances</button><button type="button" class="btn" data-act="close">Cancel</button>');
  }

  /* ---------- render ---------- */
  function view() { var v = (location.hash || '#add').slice(1); return ['add', 'month', 'worth', 'settings'].indexOf(v) >= 0 ? v : 'add'; }
  function paintSync() {
    var b = $('sync'); if (!b) return;
    b.className = 'sync';
    if (S.syncing) b.textContent = 'Syncing…';
    else if (S.queue.length) { b.textContent = S.queue.length + ' waiting'; b.classList.add('pending'); }
    else if (S.error) { b.textContent = 'Not synced'; b.classList.add('err'); }
    else if (isDemo()) b.textContent = 'Demo';
    else b.textContent = 'Synced ' + ago(S.lastSync);
  }
  function render() {
    var v = view(), el = $('view');
    var titles = { add: 'Add spending', month: 'Month', worth: 'Net worth', settings: 'Settings' };
    $('title').textContent = titles[v];
    document.querySelectorAll('.tabs a').forEach(function (a) { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var html = v === 'add' ? viewAdd() : v === 'month' ? viewMonth() : v === 'worth' ? viewWorth() : viewSettings();
    if (S.error && v !== 'settings') html = '<div class="err-box">' + esc(S.error) + '</div>' + html;
    // Keep the amount field focused (and the phone keyboard open) across re-renders on the Add screen.
    var keep = document.activeElement && document.activeElement.id && el.contains(document.activeElement) ? document.activeElement.id : null;
    el.innerHTML = html;
    if (keep && $(keep)) { try { $(keep).focus({ preventScroll: true }); } catch (e) {} }
    paintSync();
  }
  var toastTimer = null;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200); }

  /* ---------- events ---------- */
  function saveDraft() {
    if (!canSave()) return;
    var d = S.draft, amt = parseAmount(d.amount);
    var tx = { id: uid(), date: d.date || today(), amount: amt, category: d.category, note: d.note.trim(), source: d.source };
    S.draft = { amount: '', category: '', note: '', source: d.source, date: today() };
    mutate('addTransactions', { items: [tx] }, 'Saved ' + money(amt, true) + ' · ' + tx.category);
    var a = $('amt'); if (a) a.focus();
  }

  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'amt') S.draft.amount = e.target.value;
    else if (id === 'note') S.draft.note = e.target.value;
    else if (id === 'date') S.draft.date = e.target.value || today();
    else return;
    var b = $('save'); if (b) b.disabled = !canSave();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.target.id === 'amt' || e.target.id === 'note')) { e.preventDefault(); if (canSave()) saveDraft(); else e.target.blur(); }
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    var cat = t.closest('[data-cat]');
    if (cat) {
      S.draft.category = cat.dataset.cat;
      document.querySelectorAll('[data-cat]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === cat)); });
      var s1 = $('save'); if (s1) s1.disabled = !canSave();
      return;
    }
    var src = t.closest('[data-src]');
    if (src) { S.draft.source = src.dataset.src; document.querySelectorAll('[data-src]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === src)); }); return; }
    if (t.closest('#save')) { saveDraft(); return; }
    var tx = t.closest('[data-tx]'); if (tx) { openEdit(tx.dataset.tx); return; }
    var mo = t.closest('[data-month]'); if (mo) { S.month = shiftMonth(S.month, +mo.dataset.month); if (S.month > today().slice(0, 7)) S.month = today().slice(0, 7); render(); return; }
    if (t.closest('#upd-bal')) { openBalances(); return; }
    if (t.closest('#sync')) { sync(); return; }
    if (t === $('sheet')) { closeSheet(); return; }

    var act = t.closest('[data-act]');
    if (act) {
      var a = act.dataset.act;
      if (a === 'close') closeSheet();
      if (a === 'tx-update') {
        var amt = parseAmount($('e-amt').value), date = $('e-date').value;
        if (!isFinite(amt)) { $('e-err').innerHTML = '<div class="err-box">Enter an amount like 12.50.</div>'; return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { $('e-err').innerHTML = '<div class="err-box">Pick a date.</div>'; return; }
        mutate('updateTransaction', { id: act.dataset.id, fields: { amount: amt, date: date, category: $('e-cat').value, source: $('e-src').value, note: $('e-note').value.trim() } }, 'Updated');
        closeSheet();
      }
      if (a === 'tx-delete') { mutate('deleteTransaction', { id: act.dataset.id }, 'Deleted'); closeSheet(); }
      if (a === 'bal-save') {
        var bd = $('b-date').value || today(), items = [], bad = false;
        document.querySelectorAll('[data-bal]').forEach(function (inp) {
          var v = parseAmount(inp.value); if (!isFinite(v)) { bad = true; return; }
          items.push({ id: uid(), date: bd, account: inp.dataset.account, kind: inp.dataset.kind, balance: v });
        });
        var nn = $('n-name').value.trim();
        if (nn) { var nv = parseAmount($('n-bal').value); if (!isFinite(nv)) bad = true; else items.push({ id: uid(), date: bd, account: nn, kind: $('n-kind').value, balance: nv }); }
        if (bad) { $('b-err').innerHTML = '<div class="err-box">Every balance needs to be a number, like 9143.31.</div>'; return; }
        mutate('addBalances', { items: items }, 'Balances saved');
        closeSheet();
      }
      return;
    }

    if (t.closest('#cfg-show')) { var tk = $('cfg-token'); tk.type = tk.type === 'password' ? 'text' : 'password'; t.closest('#cfg-show').textContent = tk.type === 'password' ? 'Show token' : 'Hide token'; return; }
    if (t.closest('#cfg-save')) {
      var url = $('cfg-url').value.trim(), token = $('cfg-token').value.trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { S.error = 'The URL should look like https://script.google.com/macros/s/…/exec'; render(); return; }
      var switching = url !== S.cfg.apiUrl;
      S.cfg = { apiUrl: url, token: token }; save(K.cfg, S.cfg);
      if (switching) { S.data = null; save(K.cache, null); }
      S.error = '';
      call('ping').then(function () { toast(isDemo() ? 'Demo mode' : 'Connected to your sheet'); return sync(); }).catch(function (err) { S.error = explain(err); render(); });
      return;
    }
    if (t.closest('#cfg-clear')) { S.data = null; save(K.cache, null); toast('Cleared. Syncing…'); render(); sync(); return; }
    if (t.closest('#cfg-demo')) { try { localStorage.removeItem(K.demo); } catch (err) {} S.data = null; save(K.cache, null); sync(); return; }
  });
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });
  window.addEventListener('online', function () { sync(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
  setInterval(paintSync, 30000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  render();
  sync();
})();
