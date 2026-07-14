/* ConEd Rate Optimizer — DOM glue. Uses window.ConedCalc (calc.js). */
(function () {
  "use strict";
  var C = window.ConedCalc, R = C.RATES;
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), file = $("file"), err = $("error"), results = $("results");

  var usd = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var usd2 = function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var signed = function (n) { return (n >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US"); };

  function showError(msg) { err.textContent = "Couldn't read that file: " + msg; err.hidden = false; results.hidden = true; }

  function monthCost(m) {
    var std = m.total * R.standard.allIn + R.standard.customer;
    var pr = m.summer ? R.tou.peakSummer : R.tou.peakWinter;
    var tou = m.total * R.tou.nonCommodity + (m.peak * pr + m.off * R.tou.offPeak) * R.tou.gross + R.tou.customer;
    return { std: std, tou: tou };
  }

  function monthlyChart(months) {
    var W = 760, H = 200, padB = 26, padL = 4, n = months.length;
    var per = W / n, bw = Math.min(14, per / 3);
    var costs = months.map(monthCost);
    var max = Math.max.apply(null, costs.map(function (c) { return Math.max(c.std, c.tou); })) || 1;
    var svg = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly cost: Standard vs Time-of-Use">'];
    var base = H - padB;
    months.forEach(function (m, i) {
      var cx = i * per + per / 2, c = costs[i];
      var hs = (c.std / max) * (base - 8), ht = (c.tou / max) * (base - 8);
      svg.push('<rect class="bs" x="' + (cx - bw - 1) + '" y="' + (base - hs) + '" width="' + bw + '" height="' + hs + '" rx="2"/>');
      svg.push('<rect class="bt" x="' + (cx + 1) + '" y="' + (base - ht) + '" width="' + bw + '" height="' + ht + '" rx="2"/>');
      svg.push('<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + m.ym.slice(2) + '</text>');
    });
    svg.push('</svg>');
    return svg.join("") +
      '<div class="chart-legend"><span><span class="sw" style="background:var(--accent)"></span>Standard</span>' +
      '<span><span class="sw" style="background:var(--warn)"></span>Time-of-Use</span></div>';
  }

  function render(a, label) {
    err.hidden = true;
    var saves = a.savingsIfSwitch > 1;                 // >$1 to avoid rounding noise
    var vClass = saves ? "good" : "warn";
    var period = (a.ndays >= 350 && a.ndays <= 385) ? "over the past year" : "over " + a.ndays + " days (annualized)";

    // verdict
    var vHtml;
    if (saves) {
      vHtml = '<h2>You could lower your bill 🎉</h2>' +
        '<div class="big">Save ' + usd(a.savingsIfSwitch * a.annualFactor) + '/yr</div>' +
        '<p>Switching to <strong>' + a.cheapest.name + '</strong> would cost less than your current Standard plan, based on your actual usage ' + period + '.</p>';
    } else {
      vHtml = '<h2>Stay on Standard</h2>' +
        '<div class="big">' + signed(a.touDeltaAnnual) + '/yr on TOU</div>' +
        '<p>No plan switch lowers your bill. Time-of-Use would actually cost you <strong>' + signed(a.touDeltaAnnual) + '/year more</strong>, because ' +
        a.peakPct.toFixed(0) + '% of your usage falls in peak hours (8am–midnight). Rate-switching only helps off-peak-heavy homes.</p>';
    }

    // plan table
    var rows = a.plans.map(function (p) {
      var d = p.cost - a.standardCost;
      var deltaCell = p.current ? '<span class="pill">current</span>'
        : '<span class="' + (d > 0 ? "delta-up" : "delta-down") + '">' + signed(d * a.annualFactor) + '/yr</span>';
      return '<tr' + (p.current ? ' class="current"' : '') + '><td>' + p.name + '</td>' +
        '<td class="num">' + usd(p.cost * a.annualFactor) + '/yr</td><td class="num">' + deltaCell + '</td></tr>';
    }).join("");
    var variantRows = R.variants.map(function (v) {
      return '<tr class="variant"><td>' + v.name + '</td><td class="num">—</td><td>' + v.note + '</td></tr>';
    }).join("");

    // load shape
    var pk = a.peakPct, of = 100 - pk;
    var shape = '<div class="shape"><span class="peak" style="width:' + pk + '%">' + pk.toFixed(0) + '% peak</span>' +
      '<span class="off" style="width:' + of + '%">' + of.toFixed(0) + '% off</span></div>' +
      '<p class="legend">Peak = 8am–midnight · Off-peak = midnight–8am. TOU rewards off-peak-heavy usage; it penalizes peak-heavy usage.</p>';

    results.innerHTML =
      '<div class="verdict ' + vClass + '">' + vHtml + '</div>' +
      '<div class="stats">' +
        '<div class="stat"><div class="k">Your usage</div><div class="v">' + Math.round(a.totalKwh * a.annualFactor).toLocaleString() + ' kWh/yr</div></div>' +
        '<div class="stat"><div class="k">Current plan (Standard)</div><div class="v">' + usd(a.standardAnnual) + '/yr</div></div>' +
        '<div class="stat"><div class="k">Best plan</div><div class="v">' + a.cheapest.name.split(" ")[0] + '</div></div>' +
      '</div>' +
      (label ? '<p class="legend">Showing: ' + label + '</p>' : '') +
      '<h3 class="sec">Every plan, priced on your usage</h3>' +
      '<table><thead><tr><th>Rate plan</th><th class="num">Annual cost</th><th class="num">vs. Standard</th></tr></thead>' +
      '<tbody>' + rows + variantRows + '</tbody></table>' +
      '<h3 class="sec">Your load shape (why)</h3>' + shape +
      '<h3 class="sec">Month by month</h3>' + monthlyChart(a.months);

    // footer assumptions/sources
    $("assumptions").innerHTML = '<strong>Assumptions:</strong> ' + R.meta.basis + ' ' + R.meta.peakWindow + ' ' + R.meta.caveats.join(" ");
    $("sources").innerHTML = '<strong>Sources:</strong> ' + R.meta.sources.map(function (s) { return '<a href="' + s + '" target="_blank" rel="noopener">' + s.replace(/^https?:\/\//, "").split("/")[0] + "</a>"; }).join(" · ");
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleText(text, label) {
    try { render(C.analyze(C.parseGreenButton(text)), label); }
    catch (e) { showError(e.message); }
  }
  function handleFile(f) {
    if (!f) return;
    var rd = new FileReader();
    rd.onerror = function () { showError("could not read the file."); };
    rd.onload = function () {
      var buf = rd.result, u8 = new Uint8Array(buf);
      var isZip = u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04; // "PK\x03\x04"
      if (isZip) {
        C.unzipCsv(buf).then(function (t) { handleText(t, f.name); }).catch(function (e) { showError(e.message); });
      } else {
        handleText(new TextDecoder().decode(u8), f.name);
      }
    };
    rd.readAsArrayBuffer(f);
  }

  // events
  drop.addEventListener("click", function () { file.click(); });
  drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  file.addEventListener("change", function () { handleFile(file.files[0]); });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  $("sample-btn").addEventListener("click", function () {
    var s = window.CONED_SAMPLE;
    render(C.analyze({ months: s.months, ndays: s.ndays }), s.label);
  });

  // Show version on load (for bug reports)
  var vEl = document.getElementById("version");
  if (vEl && C.RATES.meta.version) vEl.textContent = "v" + C.RATES.meta.version;
})();
