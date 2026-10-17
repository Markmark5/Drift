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
    var LANE = (opt.scoreLane === 'top' || opt.scoreLane === 'bottom') && opt.scores && opt.scores.length ? opt.scoreLane : null;
    var BR = size === 'modal' || size === 'page' ? 9 : 5.5, laneH = LANE ? BR * 2 + 10 : 0, pt0 = S.pt, pb0 = S.pb;
    if (LANE) { S = Object.assign({}, S); if (LANE === 'top') S.pt += laneH; else S.pb += laneH; }
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
    if (x1 - x0 < 550 * DAY) {                       /* short record (e.g. snapshots only): month labels */
      var step = size === 'modal' || size === 'page' ? 1 : 2, d0 = new Date(x0), mi = 0;
      for (var mm = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1); mm <= x1; mm = Date.UTC(new Date(mm).getUTCFullYear(), new Date(mm).getUTCMonth() + 1, 1)) {
        if ((mi++) % step) continue;
        var md_ = new Date(mm), mo = md_.getUTCMonth();
        var ml = MON[mo] + (mo === 0 || mi === 1 ? " '" + String(md_.getUTCFullYear()).slice(2) : '');
        s += '<text x="' + X(mm).toFixed(1) + '" y="' + (H - (theme === 'light' ? 18 : 2)) + '" text-anchor="middle" font-size="' + S.fs + '" fill="' + T.axis + '">' + ml + '</text>';
      }
      y1 = y0 - 1;                                   /* skip year labels */
    }
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
    var tips = [], hits = [];   /* hits: [x, y, tipIndex, radius] in viewBox units, for nearest-mark hover */
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
      hits.push([cx, cy, idx, r]);
    });
    /* RNS Scorecard badges (opt.scores = [{d, s, t}]): score in a band-coloured circle on the price
       line at the RNS date, faint full-height guide, same scheme as Database's broker target chart.
       Lifted clear of a Text/G mark in the same week; one newer than the last close pins to it, dashed. */
    var badges = '', badgePts = [];
    if (opt.scores && opt.scores.length) {
      var markWk = {};
      (d.marks || []).forEach(function (m) { markWk[weekIndex(m.d)] = 1; });
      var lastMs = t(all[all.length - 1][0]);
      var yAt = function (ms) {
        for (var i = 0; i < all.length; i++) {
          var ti = t(all[i][0]);
          if (ti >= ms) {
            if (!i) return all[0][1];
            var tp = t(all[i - 1][0]), f = (ms - tp) / (ti - tp);
            return all[i - 1][1] + (all[i][1] - all[i - 1][1]) * f;
          }
        }
        return all[all.length - 1][1];
      };
      var R = BR, bfs = size === 'modal' || size === 'page' ? 8 : 5.5;
      render._laneX = null;
      opt.scores.slice().sort(function (a, b) { return a.d < b.d ? -1 : 1; }).forEach(function (b) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(b.d || '') || typeof b.s !== 'number') return;
        var ms = t(b.d.slice(0, 10)); if (ms < x0) return;
        var pinned = ms > lastMs + 3 * DAY, bx = X(Math.min(ms, lastMs)), by = Y(yAt(Math.min(ms, lastMs)));
        var tx = bx, ty = by;                         /* true point on the price line */
        if (LANE) {
          bx = Math.max(bx, (render._laneX || -1e9) + 2 * R + 2); render._laneX = bx;
          by = LANE === 'top' ? pt0 + R + 3 : base + 7 + R;
        }
        var wi = weekIndex(b.d.slice(0, 10));
        if (!LANE) {
          if (!tail.length || ms <= t(px[px.length - 1][0])) { if (markWk[wi]) by -= r + R + 3; }
          by = Math.max(S.pt + R, Math.min(base - R, by));
        }
        var sc = Math.max(0, Math.min(100, Math.round(b.s)));
        var col = sc >= 75 ? '#00c814' : sc >= 50 ? '#ffc400' : '#e02525';
        var faint = sc >= 75 ? 'rgba(0,200,20,.18)' : sc >= 50 ? 'rgba(245,179,47,.18)' : 'rgba(224,37,37,.18)';
        var ti_ = tips.length;
        tips.push('<b>' + esc(fmtDate(b.d.slice(0, 10))) + ' · RNS Scorecard</b><br>Score <b style="color:' + col + '">' + sc +
          '</b>/100' + (b.t ? ' · ' + esc(b.t) : '') + (pinned ? '<br><i>after the last weekly close</i>' : ''));
        if (LANE) {
          var ey = LANE === 'top' ? by + R : by - R;
          badges += '<line x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + S.pt + '" y2="' + base + '" stroke="' + faint + '"/>';
          badges += '<polyline points="' + bx.toFixed(1) + ',' + ey.toFixed(1) + ' ' + tx.toFixed(1) + ',' + (LANE === 'top' ? S.pt : base) + '" fill="none" stroke="' + col + '" stroke-opacity=".55" stroke-width="1"/>';
          badges += '<circle cx="' + tx.toFixed(1) + '" cy="' + ty.toFixed(1) + '" r="' + (R * 0.28).toFixed(1) + '" fill="' + col + '"/>';
        } else
        badges += '<line x1="' + bx.toFixed(1) + '" x2="' + bx.toFixed(1) + '" y1="' + S.pt + '" y2="' + base + '" stroke="' + faint + '"/>';
        badgePts.push([bx, by, R]);
        hits.push([bx, by, ti_, R]);
        badges += '<g class="dc-mk" data-i="' + ti_ + '"><circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="' + R + '" fill="' + col +
          '" stroke="rgba(255,255,255,.85)" stroke-width="1"' + (pinned ? ' stroke-dasharray="2 2"' : '') + '/>' +
          '<text x="' + bx.toFixed(1) + '" y="' + (by + bfs * 0.36).toFixed(1) + '" text-anchor="middle" font-size="' + bfs +
          '" font-weight="700" fill="#0d0d16" font-family="Inter,system-ui,sans-serif">' + sc + '</text>' +
          '<circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="' + (R * 2) + '" fill="transparent"/></g>';
      });
    }
    s += badges + dots + arrows;                     /* arrows last: on top of a same-week dot */

    /* last close (dark) */
    if (theme === 'dark') {
      var last = tail.length ? tail[tail.length - 1] : px[px.length - 1], lx = X(t(last[0])), ly = Y(last[1]);
      /* a score badge sitting on the last close wins: no white dot over its number */
      var covered = (badgePts || []).some(function (q) { return Math.abs(q[0] - lx) < q[2] + 2 && Math.abs(q[1] - ly) < q[2] + 2; });
      if (!covered) s += '<circle cx="' + X(t(last[0])).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="' + (size === 'modal' ? 3 : 2) + '" fill="#fff"/>';
    }
    s += '</svg>';
    el.innerHTML = s;
    el._dcTips = tips;
    el._dcHits = hits;

    if (!el._dcBound) {
      el._dcBound = true;
      el.addEventListener('mousemove', function (ev) {
        /* nearest mark wins: when marks sit close together, the one under the cursor is
           the one whose centre is closest, not whichever invisible hit area was drawn last */
        var svg = el.querySelector('svg'), best = null;
        if (svg && el._dcHits && el._dcHits.length && svg.getScreenCTM()) {
          var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
          var p = pt.matrixTransform(svg.getScreenCTM().inverse()), bd = Infinity;
          el._dcHits.forEach(function (h) {
            var d = Math.sqrt((h[0] - p.x) * (h[0] - p.x) + (h[1] - p.y) * (h[1] - p.y));
            if (d <= h[3] * 2.5 && d < bd) { bd = d; best = h; }
          });
        }
        var ad = ev.target.closest && ev.target.closest('.dc-adj');
        if (best) {
          /* two prints in the same week share one point: show them together, oldest first */
          var same = el._dcHits.filter(function (h) { return Math.abs(h[0] - best[0]) < 1.5 && Math.abs(h[1] - best[1]) < 1.5; });
          showTip(el._dcTheme, same.map(function (h) { return el._dcTips[h[2]]; })
            .join('<hr style="border:0;border-top:1px solid rgba(128,128,128,.35);margin:6px 0">'), ev);
        }
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


  /* ---------- EPS forecasts from rows4 (fields 2 and 3: FY1, FY2) ---------- */
  function parseEps(rows4, ticker) {
    var tk = String(ticker).toUpperCase(), out = {};
    (rows4 || []).forEach(function (row) {
      if (!row || !row.Date || !row.Snapshot) return;
      var dp = String(row.Date).split('/'); if (dp.length !== 3) return;
      var iso = dp[2] + '-' + ('0' + dp[1]).slice(-2) + '-' + ('0' + dp[0]).slice(-2);
      var recs = String(row.Snapshot).split(';');
      for (var i = 0; i < recs.length; i++) {
        var f = recs[i].split(',');
        if ((f[0] || '').toUpperCase() !== tk) continue;
        var a = parseFloat(f[1]), b = parseFloat(f[2]);
        out[iso] = [iso, isFinite(a) ? a : null, isFinite(b) ? b : null];
        break;
      }
    });
    return Object.keys(out).sort().map(function (k) { return out[k]; });
  }
  /* year-end roll: the new FY1 is within 12% of the old FY2 and has moved >15% from the old FY1 */
  function epsYears(e, given) {
    var R = given ? given.slice() : [];
    for (var i = 1; !given && i < e.length; i++) {
      var a = e[i - 1], b = e[i];
      if (a[1] && a[2] && b[1] && Math.abs(b[1] - a[2]) / Math.abs(a[2]) < 0.12 && Math.abs(b[1] - a[1]) / Math.abs(a[1]) > 0.15) R.push(i);
    }
    var yrs = {}, ri = 0;
    e.forEach(function (r, i) {
      while (ri < R.length && R[ri] <= i) ri++;
      if (r[1] != null) (yrs[ri] = yrs[ri] || []).push([r[0], r[1]]);
      if (r[2] != null) (yrs[ri + 1] = yrs[ri + 1] || []).push([r[0], r[2]]);
    });
    return { rolls: R, cur: yrs[R.length] || [], nxt: yrs[R.length + 1] || [] };
  }
  /* EPS panel under a modal chart. opt.x0/x1 = the price chart's date range (ms) so the axes line up.
     style 'lines': this year solid amber, next year dashed purple. style 'bars': one bar per week for this
     year's forecast, coloured by the week's change (green up / red down / grey flat). */
  function epsPanel(el, e, opt) {
    opt = opt || {};
    var S = SIZES[opt.size || 'modal'], W = S.W, H = opt.h || 130, pt = 14, pb = 16, A = '#ffb347', P = '#c07ef7';
    if (!e || e.length < 2) { el.innerHTML = ''; return; }
    var Y_ = epsYears(e, opt.rolls), cur = Y_.cur, nxt = opt.style === 'bars' ? [] : Y_.nxt;
    if (cur.length < 2) { el.innerHTML = ''; return; }
    var x0 = opt.x0, x1 = opt.x1;
    function X(iso) { return S.pl + (t(iso) - x0) / ((x1 - x0) || 1) * (W - S.pl - S.pr); }
    var v = cur.concat(nxt).map(function (p) { return p[1]; }), lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
    function Y(x) { return pt + (hi - x) / (hi - lo) * (H - pt - pb); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto">';
    s += '<line x1="' + S.pl + '" x2="' + (W - S.pr) + '" y1="0.5" y2="0.5" stroke="#1e1e28"/>';
    s += '<text x="' + S.pl + '" y="10" font-size="9" letter-spacing=".08em" fill="#5a5a72">EPS FORECASTS</text>';
    var labels = '';
    function pctLab(ser) {
      for (var i = 1; i < ser.length; i++) {
        var ch = (ser[i][1] / ser[i - 1][1] - 1) * 100;
        if (Math.abs(ch) >= 3 && isFinite(ch)) {
          var x = X(ser[i][0]), y = Y(ser[i][1]);
          labels += '<text x="' + x.toFixed(1) + '" y="' + (ch > 0 ? Math.max(pt + 8, y - 5) : y + 11).toFixed(1) + '" text-anchor="middle" font-size="9" fill="' +
            (ch > 0 ? '#00d97e' : '#ff4757') + '">' + (ch > 0 ? '+' : '') + ch.toFixed(1) + '%</text>';
        }
      }
    }
    if (opt.style === 'bars') {
      var bw = Math.max(2, Math.min(14, (W - S.pl - S.pr) / ((x1 - x0) / (7 * DAY)) * 0.7)), bot = H - pb;
      cur.forEach(function (p, i) {
        var ch = i ? p[1] - cur[i - 1][1] : 0, col = ch > 0 ? '#00d97e' : ch < 0 ? '#ff4757' : '#3a3a50', x = X(p[0]), y = Y(p[1]);
        s += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, bot - y).toFixed(1) + '" fill="' + col + '" rx="1"/>';
      });
    } else if (opt.style === 'area') {
      /* Earnings Whispers-style forward-estimate step area, drawn in its own strip */
      var step = function (ser) { var o = [];
        ser.forEach(function (p, i) { var x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1);
          if (i) o.push(x + ',' + Y(ser[i - 1][1]).toFixed(1)); o.push(x + ',' + y); }); return o; };
      var bot2 = H - pb, sc_ = step(cur);
      s += '<polygon points="' + X(cur[0][0]).toFixed(1) + ',' + bot2 + ' ' + sc_.join(' ') + ' ' + X(cur[cur.length - 1][0]).toFixed(1) + ',' + bot2 +
        '" fill="#d9a066" fill-opacity=".22"/>';
      s += '<polyline points="' + sc_.join(' ') + '" fill="none" stroke="#d9a066" stroke-width="1.4"/>';
      if (nxt.length > 1) s += '<polyline points="' + step(nxt).join(' ') + '" fill="none" stroke="' + P + '" stroke-width="1.1" stroke-dasharray="4 3"/>';
      A = '#d9a066';
    } else {
      [[nxt, P, true], [cur, A, false]].forEach(function (z) {
        if (z[0].length < 2) return;
        s += '<polyline points="' + z[0].map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ') +
          '" fill="none" stroke="' + z[1] + '" stroke-width="' + (z[2] ? 1.2 : 1.6) + '"' + (z[2] ? ' stroke-dasharray="4 3"' : '') + '/>';
      });
    }
    pctLab(cur);
    Y_.rolls.forEach(function (i) {
      var x = X(e[i][0]);
      s += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + pt + '" y2="' + (H - pb) + '" stroke="#9a9ab5" stroke-dasharray="2 3" opacity=".5"/>' +
        '<text x="' + (x + 4).toFixed(1) + '" y="' + (H - pb - 3) + '" font-size="9" fill="#9a9ab5">results · year rolled</text>';
    });
    var l1 = cur[cur.length - 1][1], l2 = nxt.length ? nxt[nxt.length - 1][1] : null, y1 = Y(l1), y2 = l2 != null ? Y(l2) : null;
    if (y2 != null && Math.abs(y1 - y2) < 11) { if (y1 > y2) y1 = y2 + 11; else y2 = y1 + 11; }
    labels += '<text x="' + (W - S.pr + 4) + '" y="' + (y1 + 3).toFixed(1) + '" font-size="10" fill="' + A + '">' + l1 + 'p</text>';
    if (y2 != null) labels += '<text x="' + (W - S.pr + 4) + '" y="' + (y2 + 3).toFixed(1) + '" font-size="10" fill="' + P + '">' + l2 + 'p</text>';
    el.innerHTML = s + labels + '</svg>';
  }

  root.DriftChart = { render: render, legend: legend, validate: validate, parseTail: parseTail,
                      mountFromPage: mountFromPage, parseEps: parseEps, epsPanel: epsPanel, version: '1.6' };
})(typeof window !== 'undefined' ? window : this);
