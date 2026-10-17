/* ==== DRIFT PRICE OVERLAY — chart.js — master copy (Drift repo) ====
   Spec: "Drift price overlay — architecture note", 17 Oct 2026.
   ONE renderer, two themes. Drift dashboards paste this file in verbatim
   (light theme, frozen at build); Database and the wall load it live (dark).
   Display only: it scores nothing and fires nothing.

   API
     DriftChart.render(el, data, {theme:'light'|'dark', size:'page'|'card'|'preview'|'modal', tail:[[iso,price],…]})
     DriftChart.legend(theme)                  -> HTML string
     DriftChart.validate(data)                 -> [] or list of error strings
     DriftChart.parseTail(rows4, ticker, ccy, afterIso) -> [[iso,price],…] (dark theme only)
     DriftChart.mountFromPage()                -> renders the dashboard panel from #drift-chart
*/
(function (root) {
  'use strict';

  var THEMES = {
    light: { line: '#2f9e5c', fill: '#2f9e5c', fillOp: 0.08, pos: '#2546f0', neg: '#ff2d2d',
             zeroFill: '#fff', zeroStroke: '#6b6860', outline: '#fff', grid: '#e4e1da',
             axis: '#6b6860', adj: '#8d8981', tipBg: '#fff', tipFg: '#16150f', tipBorder: '#d8d5cf' },
    dark:  { line: '#c9c6d8', fill: '#fff', fillOp: 0.04, pos: '#00d97e', neg: '#ff4757',
             zeroFill: '#0a0a0f', zeroStroke: '#9a9ab5', outline: '#0a0a0f', grid: '#1e1e28',
             axis: '#5a5a72', adj: '#3a3a50', tail: '#8a8aa0', tipBg: '#1a1a24', tipFg: '#f2f2f8',
             tipBorder: '#3a3a50' }
  };
  /* geometry per size: viewBox W×H, padding, mark radius, arrow width, line width, font size */
  var SIZES = {
    page:    { W: 1100, H: 400, pl: 46, pr: 16, pt: 24, pb: 40, r: 8,   aw: 22, lw: 1.4, fs: 11 },
    modal:   { W: 940,  H: 340, pl: 10, pr: 46, pt: 14, pb: 22, r: 6,   aw: 16, lw: 1.6, fs: 11 },
    preview: { W: 360,  H: 110, pl: 4,  pr: 34, pt: 8,  pb: 14, r: 2.6, aw: 8,  lw: 1.1, fs: 8 },
    card:    { W: 340,  H: 92,  pl: 4,  pr: 34, pt: 8,  pb: 14, r: 2.6, aw: 8,  lw: 1.1, fs: 8 }
  };
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DAY = 86400000;

  function t(iso) { return Date.parse(iso + 'T00:00:00Z'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtDate(iso, short) { var p = iso.split('-');
    return short ? (p[2] + ' ' + MON[+p[1] - 1]) : (p[2] + ' ' + MON[+p[1] - 1] + ' ' + p[0]); }
  function fmtPx(v, ccy) {
    if (ccy === 'USD') return '$' + v.toFixed(2);
    var s = Math.abs(v) >= 100 ? v.toFixed(0) : (Math.round(v * 10) / 10).toString();
    return s + 'p';
  }
  function fmtScore(s) { return s > 0 ? '+' + s : (s < 0 ? '−' + Math.abs(s) : '0'); }
  function niceStep(max) {
    var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= raw) return steps[i] * mag;
    return 10 * mag;
  }

  /* ---------- validation (used by the upload panel) ---------- */
  function validate(d) {
    var e = [];
    if (!d || typeof d !== 'object') return ['drift-chart is not an object'];
    if (!d.ticker) e.push('ticker missing');
    if (!d.v) e.push('v missing');
    if (d.ccy !== 'GBX' && d.ccy !== 'USD') e.push('ccy must be GBX or USD');
    if (!Array.isArray(d.px) || d.px.length < 2) { e.push('px must be an array of at least 2 weeks'); return e; }
    for (var i = 0; i < d.px.length; i++) {
      var p = d.px[i];
      if (!Array.isArray(p) || !/^\d{4}-\d{2}-\d{2}$/.test(p[0]) || typeof p[1] !== 'number' || !isFinite(p[1])) {
        e.push('px[' + i + '] is not [YYYY-MM-DD, number]'); return e; }
      if (i && p[0] <= d.px[i - 1][0]) { e.push('px not in ascending date order at ' + p[0]); return e; }
    }
    var first = t(d.px[0][0]), last = t(d.px[d.px.length - 1][0]);
    if (!Array.isArray(d.marks)) { e.push('marks must be an array'); return e; }
    d.marks.forEach(function (m, i) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.d || '')) { e.push('marks[' + i + '] date invalid'); return; }
      var md = t(m.d);
      if (md < first - 7 * DAY || md > last + 7 * DAY)
        e.push('mark ' + m.d + ' falls outside the price range (allowed up to 7 days after the last close)');
      if (['RAISE', 'CUT', 'flat'].indexOf(m.g) < 0) e.push('mark ' + m.d + ' g must be RAISE, CUT or flat');
      if (typeof m.s !== 'number' || m.s < -3 || m.s > 3 || Math.round(m.s) !== m.s) e.push('mark ' + m.d + ' s must be an integer −3..+3');
    });
    return e;
  }

  /* ---------- snapshot tail from Database uploadZone.rows4 (§7) ---------- */
  function parseTail(rows4, ticker, ccy, afterIso) {
    if (!Array.isArray(rows4)) return [];
    var tk = String(ticker).toUpperCase(), out = {};
    rows4.forEach(function (row) {
      if (!row || !row.Date || !row.Snapshot) return;
      var dp = String(row.Date).split('/');
      if (dp.length !== 3) return;
      var iso = dp[2] + '-' + ('0' + dp[1]).slice(-2) + '-' + ('0' + dp[0]).slice(-2);
      if (afterIso && iso <= afterIso) return;
      var recs = String(row.Snapshot).split(';');
      for (var i = 0; i < recs.length; i++) {
        var f = recs[i].split(',');
        if ((f[0] || '').toUpperCase() !== tk) continue;
        var raw = (f[6] || '').trim();            /* 7th field — never the last field */
        if (!raw) break;
        var v = null, m;
        if ((m = raw.match(/^([\d.]+)p$/)))        { if (ccy === 'GBX') v = +m[1]; }
        else if ((m = raw.match(/^([\d.]+)$/)))    { if (ccy === 'GBX') v = Math.round(+m[1] * 10000) / 100; }  /* pounds */
        else if ((m = raw.match(/^([\d.]+)¢$/))) { if (ccy === 'USD') v = +m[1] / 100; } /* cents */
        else if ((m = raw.match(/^\$([\d.]+)$/)))  { if (ccy === 'USD') v = +m[1]; }
        if (v != null && isFinite(v) && v > 0) out[iso] = v;
        break;
      }
    });
    var tail = Object.keys(out).sort().map(function (k) { return [k, out[k]]; });
    for (var j = 1; j < tail.length; j++) {
      var a = tail[j - 1][1], b = tail[j][1];
      if (b / a > 5 || a / b > 5) return [];       /* cliff check */
    }
    return tail;
  }

  /* ---------- shared tooltip ---------- */
  var tipEl = null;
  function tip(theme) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'dc-tip';
      tipEl.style.cssText = 'position:fixed;pointer-events:none;z-index:10000;display:none;max-width:300px;' +
        'padding:7px 9px;border-radius:4px;font:11px/1.45 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)';
      document.body.appendChild(tipEl);
    }
    var T = THEMES[theme];
    tipEl.style.background = T.tipBg; tipEl.style.color = T.tipFg; tipEl.style.border = '1px solid ' + T.tipBorder;
    return tipEl;
  }
  function showTip(theme, html, ev) {
    var el = tip(theme); el.innerHTML = html; el.style.display = 'block';
    var x = ev.clientX + 14, y = ev.clientY + 14, w = el.offsetWidth, h = el.offsetHeight;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  /* ---------- render ---------- */
  function render(el, d, opt) {
    opt = opt || {};
    var theme = opt.theme === 'dark' ? 'dark' : 'light', T = THEMES[theme];
    var size = SIZES[opt.size] ? opt.size : (theme === 'light' ? 'page' : 'preview'), S = SIZES[size];
    var errs = validate(d);
    if (errs.length) { el.innerHTML = '<div style="font:12px sans-serif;color:' + T.axis + ';padding:10px">no price data</div>'; return; }
    var px = d.px, ccy = d.ccy;
    var tail = theme === 'dark' && opt.tail && opt.tail.length ? opt.tail : [];
    var all = px.concat(tail);
    var x0 = t(px[0][0]), x1 = t(all[all.length - 1][0]);
    var vals = all.map(function (p) { return p[1]; });
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    var lo, hi;
    if (theme === 'light') { var st = niceStep(vmax); lo = 0; hi = Math.ceil(vmax / st) * st; }
    else { var pad = (vmax - vmin) * 0.04 || 1; lo = vmin - pad; hi = vmax + pad; }
    var W = S.W, H = S.H;
    function X(ms) { return S.pl + (ms - x0) / ((x1 - x0) || 1) * (W - S.pl - S.pr); }
    function Y(v) { return S.pt + (hi - v) / ((hi - lo) || 1) * (H - S.pt - S.pb); }
    var base = H - S.pb, s = '';
    s += '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" ' +
         'aria-label="Weekly share price with Text and G markers" style="display:block;width:100%;height:auto">';

    /* axes */
    if (theme === 'light') {
      for (var g = lo; g <= hi + 1e-9; g += niceStep(vmax)) {
        s += '<line x1="' + S.pl + '" x2="' + (W - S.pr) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" stroke="' + T.grid + '"/>';
        s += '<text x="' + (S.pl - 8) + '" y="' + (Y(g) + 4).toFixed(1) + '" text-anchor="end" font-size="' + S.fs + '" fill="' + T.axis + '">' + esc(fmtPx(g, ccy)) + '</text>';
      }
    } else {
      [[vmax], [vmin]].forEach(function (a) {
        var y = Y(a[0]).toFixed(1);
        s += '<line x1="' + S.pl + '" x2="' + (W - S.pr) + '" y1="' + y + '" y2="' + y + '" stroke="' + T.grid + '"/>';
        s += '<text x="' + (W - S.pr + 4) + '" y="' + (+y + S.fs * 0.35).toFixed(1) + '" font-size="' + S.fs + '" fill="' + T.axis + '">' + esc(fmtPx(a[0], ccy)) + '</text>';
      });
    }
    var y0 = new Date(x0).getUTCFullYear(), y1 = new Date(x1).getUTCFullYear();
    for (var yr = y0; yr <= y1; yr++) {
      var mid = Date.UTC(yr, 6, 1);                    /* label mid-year, tick at 1 Jan */
      var jan = Date.UTC(yr, 0, 1);
      if (jan >= x0 && jan <= x1 && theme === 'light')
        s += '<line x1="' + X(jan).toFixed(1) + '" x2="' + X(jan).toFixed(1) + '" y1="' + base + '" y2="' + (base + 5) + '" stroke="' + T.adj + '"/>';
      if (mid < x0 || mid > x1) continue;
      var lab = theme === 'light' || size === 'modal' ? String(yr) : "'" + String(yr).slice(2);
      s += '<text x="' + X(mid).toFixed(1) + '" y="' + (H - (theme === 'light' ? 18 : 2)) + '" text-anchor="middle" font-size="' + S.fs + '" fill="' + T.axis + '">' + lab + '</text>';
    }

    /* consolidation rule(s) */
    (d.adj || []).forEach(function (a) {
      var ax = X(t(a.before)).toFixed(1);
      if (+ax < S.pl || +ax > W - S.pr) return;
      var why = a.factor + ':1 consolidation — earlier closes ×' + a.factor;
      s += '<g class="dc-adj" data-tip="' + esc(why) + '">';
      s += '<line x1="' + ax + '" x2="' + ax + '" y1="' + S.pt + '" y2="' + base + '" stroke="' + T.adj + '" stroke-dasharray="4 4"' + (theme === 'dark' ? ' opacity=".7"' : '') + '/>';
      s += '<rect x="' + (+ax - 5) + '" y="' + S.pt + '" width="10" height="' + (base - S.pt) + '" fill="transparent"/>';
      if (theme === 'light') s += '<text x="' + (+ax + 5) + '" y="' + (S.pt + 12) + '" font-size="' + (S.fs - 1) + '" fill="' + T.axis + '">' + a.factor + ':1 consolidation</text>';
      s += '</g>';
    });

    /* price area + line */
    var pts = px.map(function (p) { return X(t(p[0])).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ');
    var fx0 = X(t(px[0][0])).toFixed(1), fx1 = X(t(px[px.length - 1][0])).toFixed(1);
    s += '<polygon points="' + fx0 + ',' + base + ' ' + pts + ' ' + fx1 + ',' + base + '" fill="' + T.fill + '" fill-opacity="' + T.fillOp + '"/>';
    s += '<polyline points="' + pts + '" fill="none" stroke="' + T.line + '" stroke-width="' + S.lw + '" stroke-linejoin="round"/>';

    /* snapshot tail (dark only) */
    if (tail.length) {
      var lp = px[px.length - 1];
      var tp = [lp].concat(tail).map(function (p) { return X(t(p[0])).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ');
      s += '<polyline points="' + tp + '" fill="none" stroke="' + T.tail + '" stroke-opacity=".7" stroke-width="' + S.lw + '" stroke-dasharray="3 3"/>';
      if (size === 'modal') {
        var tx = X(t(tail[0][0]));
        s += '<line x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + S.pt + '" y2="' + base + '" stroke="' + T.grid + '"/>';
        s += '<text x="' + (tx - 4).toFixed(1) + '" y="' + (base - 5) + '" text-anchor="end" font-size="' + (S.fs - 1) + '" fill="' + T.axis + '">ShareScope weekly snapshots \u2192</text>';
      }
    }

    /* marks: each on the close of the week containing its RNS date */
    function weekIndex(iso) {
      var md = t(iso);
      for (var i = 0; i < px.length; i++) if (t(px[i][0]) >= md) return i;
      return px.length - 1;                         /* within 7 days after the last close */
    }
    var tips = [];
    var dots = '', arrows = '', r = S.r, aw = S.aw / 2, ah = S.aw * 0.95;
    (d.marks || []).forEach(function (m, idx) {
      var wi = weekIndex(m.d), wk = px[wi], cx = X(t(wk[0])), cy = Y(wk[1]);
      var gtxt = m.g === 'flat' ? 'flat' : (m.g === 'RAISE' ? '▲ RAISE' : '▼ CUT') + (m.gnote ? ' (' + m.gnote + ')' : '');
      var tipHtml = '<b>' + esc(fmtDate(m.d)) + ' · ' + esc(m.fy || '') + ' ' + esc(m.doc || '') + '</b><br>' +
        'Text ' + fmtScore(m.s) + ' · G ' + esc(gtxt) + '<br>' +
        'Week close ' + esc(fmtPx(wk[1], ccy)) + ' (' + esc(fmtDate(wk[0], true)) + ')' +
        (m.q ? '<div style="margin-top:4px;opacity:.85;font-style:italic">“' + esc(m.q) + '”</div>' : '');
      var g = '<g class="dc-mk" data-i="' + idx + '" style="cursor:default">';
      var hit = '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (r * 3).toFixed(1) + '" fill="transparent"/>';
      var sw = size === 'page' ? 1.8 : 1;
      if (m.g === 'RAISE' || m.g === 'CUT') {
        var c = m.g === 'RAISE' ? T.pos : T.neg, up = m.g === 'RAISE';
        var tip_ = up ? (cy - ah * 0.6) : (cy + ah * 0.6), b = up ? (cy + ah * 0.4) : (cy - ah * 0.4);
        arrows += g + '<polygon points="' + cx.toFixed(1) + ',' + tip_.toFixed(1) + ' ' + (cx - aw).toFixed(1) + ',' + b.toFixed(1) + ' ' +
          (cx + aw).toFixed(1) + ',' + b.toFixed(1) + '" fill="' + c + '" stroke="' + T.outline + '" stroke-width="' + sw + '"/>' + hit + '</g>';
      } else if (m.s === 0) {
        dots += g + '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (r * 0.88).toFixed(1) + '" fill="' + T.zeroFill +
          '" stroke="' + T.zeroStroke + '" stroke-width="' + (size === 'page' ? 2.2 : 1.2) + '"/>' + hit + '</g>';
      } else {
        dots += g + '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r + '" fill="' + (m.s > 0 ? T.pos : T.neg) +
          '" stroke="' + T.outline + '" stroke-width="' + sw + '"/>' + hit + '</g>';
      }
      tips[idx] = tipHtml;
    });
    s += dots + arrows;                              /* arrows last: on top of a same-week dot */

    /* last close (dark) */
    if (theme === 'dark') {
      var last = tail.length ? tail[tail.length - 1] : px[px.length - 1];
      s += '<circle cx="' + X(t(last[0])).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="' + (size === 'modal' ? 3 : 2) + '" fill="#fff"/>';
    }
    s += '</svg>';
    el.innerHTML = s;
    el._dcTips = tips;

    if (!el._dcBound) {
      el._dcBound = true;
      el.addEventListener('mousemove', function (ev) {
        var mk = ev.target.closest && ev.target.closest('.dc-mk');
        var ad = ev.target.closest && ev.target.closest('.dc-adj');
        if (mk) showTip(el._dcTheme, el._dcTips[+mk.getAttribute('data-i')], ev);
        else if (ad) showTip(el._dcTheme, esc(ad.getAttribute('data-tip')), ev);
        else hideTip();
      });
      el.addEventListener('mouseleave', hideTip);
    }
    el._dcTheme = theme;
  }

  function legend(theme) {
    var T = THEMES[theme === 'dark' ? 'dark' : 'light'];
    var dot = function (c, ring) { return '<i style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:0;' +
      (ring ? 'border:1.5px solid ' + T.zeroStroke + ';background:' + T.zeroFill : 'background:' + c) + '"></i>'; };
    return '<span class="dc-leg" style="display:inline-flex;gap:10px;flex-wrap:wrap;font-size:inherit">' +
      '<span>' + dot(T.pos) + 'Text +</span><span>' + dot(T.neg) + 'Text −</span><span>' + dot(null, true) + '0</span>' +
      '<span style="color:' + T.pos + '">▲ G raise</span><span style="color:' + T.neg + '">▼ G cut</span></span>';
  }

  function mountFromPage() {
    var src = document.getElementById('drift-chart'), el = document.querySelector('[data-drift-chart]');
    if (!src || !el) return;
    try { render(el, JSON.parse(src.textContent), { theme: 'light', size: 'page' }); }
    catch (e) { el.innerHTML = '<div style="padding:10px;color:#6b6860">no price data</div>'; }
  }

  root.DriftChart = { render: render, legend: legend, validate: validate, parseTail: parseTail,
                      mountFromPage: mountFromPage, version: '1.0' };
})(typeof window !== 'undefined' ? window : this);
