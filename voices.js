// 「届いた声と動き」の盤面。LIFF の中（index.html の ?v=map）と、LINEの外から見る voices.html の両方が読む。
// データは GAS の ?action=voice_public（鍵なし・要約と件数だけ）。window.VOICE_SAMPLE があればそれを使う（ローカルでの見た目確認）
(function (global) {
  "use strict";

  var SEL = ""; // いま開いているテーマ

  function elm(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  }

  // 件数を伏せているテーマは月までしか来ない（yyyy-MM）。日付が来たときだけ M/d で出す
  function jpDay(ymd) {
    var d = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (d) return Number(d[2]) + "/" + Number(d[3]);
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})$/);
    return m ? Number(m[2]) + "月" : String(ymd || "");
  }
  function jpMonth(ym) {
    var m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
    return m ? m[1] + "年" + Number(m[2]) + "月" : "";
  }

  // 件数のセル。0＝まだ届いていない、"<K"＝人数が少ないので数は出さない
  function cellText(v, k) {
    if (v === "<K") return k + "件未満";
    return String(v || 0);
  }
  function cellClass(v) {
    if (v === "<K") return "vb-cell few";
    return Number(v) > 0 ? "vb-cell on" : "vb-cell zero";
  }

  // Cloudflare の写し（/voices）を先に読み、無い・読めないときは GAS から直接
  function loadPublic() {
    if (global.VOICE_SAMPLE) return Promise.resolve(global.VOICE_SAMPLE);
    var cfg = global.SITE_CONFIG || {};
    var urls = [];
    if (cfg.WORKER) urls.push(String(cfg.WORKER).replace(/\/$/, "") + "/voices");
    if (cfg.API) urls.push(cfg.API + (cfg.API.indexOf("?") >= 0 ? "&" : "?") + "action=voice_public");
    if (!urls.length) return Promise.reject(new Error("公開データの取得先が未設定です（config.js の API）"));
    var at = function (i) {
      return fetch(urls[i]).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || j.error) throw new Error((j && j.error) || "公開データを読めませんでした");
        return j;
      }).catch(function (e) { return i + 1 < urls.length ? at(i + 1) : Promise.reject(e); });
    };
    return at(0);
  }

  function board(data, mount) {
    mount.innerHTML = "";
    var wrap = elm("div", "vb");

    var head = elm("div", "vb-legend");
    head.appendChild(elm("span", "", "縦が声のテーマ、横がその後の進み方です。"));
    head.appendChild(elm("span", "", "人数が" + data.k + "人に満たないところは、書いた人が分からないように件数を伏せています。"));
    head.appendChild(elm("span", "vb-swipe", "表は横に動かすと、右端の「変わった」と最終更新まで見られます。"));
    wrap.appendChild(head);

    var scroll = elm("div", "vb-scroll");
    var grid = elm("div", "vb-grid");
    grid.style.setProperty("--stages", String((data.stages || []).length));
    grid.appendChild(elm("div", "vb-th vb-first", "テーマ"));
    (data.stages || []).forEach(function (s) { grid.appendChild(elm("div", "vb-th", s)); });
    grid.appendChild(elm("div", "vb-th vb-last", "最終更新"));

    (data.themes || []).forEach(function (t) {
      var name = elm("button", "vb-name vb-first");
      name.type = "button";
      name.appendChild(elm("span", "", t.theme));
      if (t.stale) name.appendChild(elm("span", "vb-stale", "確認中"));
      name.onclick = function () { select(data, mount, t.theme); };
      grid.appendChild(name);
      (data.stages || []).forEach(function (s, si) {
        var v = (t.counts || {})[s];
        // 右端の段階（変わった）だけ色を変えるので、その列に印を付ける
        var c = elm("button", cellClass(v) + (si === (data.stages || []).length - 1 ? " vb-goal" : ""), cellText(v, data.k));
        c.type = "button";
        c.setAttribute("aria-label", t.theme + " ／ " + s + " ／ " + cellText(v, data.k));
        c.onclick = function () { select(data, mount, t.theme); };
        grid.appendChild(c);
      });
      grid.appendChild(elm("div", "vb-up vb-last", t.updated ? jpDay(t.updated) : "—"));
    });
    scroll.appendChild(grid);
    wrap.appendChild(scroll);

    var detail = elm("div", "vb-detail");
    detail.id = "vb_detail";
    wrap.appendChild(detail);

    var foot = elm("div", "vb-foot");
    foot.textContent = "公開しているのは、個人や施設が分からない形にした要約と件数だけです。原文は連盟の担当だけが読みます。"
      + (data.at ? "（" + String(data.at).slice(0, 10) + " 時点）" : "");
    wrap.appendChild(foot);

    mount.appendChild(wrap);
    /* 「私も同じ」ボタンはここに置く想定（今回は作らない） */
    select(data, mount, SEL || (data.themes && data.themes.length ? data.themes[0].theme : ""));
  }

  function select(data, mount, theme) {
    SEL = theme;
    var box = mount.querySelector("#vb_detail");
    if (!box) return;
    var t = (data.themes || []).filter(function (x) { return x.theme === theme; })[0];
    var cells = mount.querySelectorAll(".vb-name");
    for (var i = 0; i < cells.length; i++) cells[i].classList.toggle("sel", cells[i].textContent.indexOf(theme) === 0);
    box.innerHTML = "";
    if (!t) return;

    var h = elm("div", "vb-dt");
    h.appendChild(elm("span", "", t.theme));
    if (t.stale) h.appendChild(elm("span", "vb-stale", "確認中"));
    box.appendChild(h);
    box.appendChild(elm("div", "vb-sub", t.stale
      ? "このテーマは" + data.staleDays + "日以上、新しい記録がありません。いまの状況を確認しています"
      : "最終更新 " + (t.updated ? jpDay(t.updated) : "—") + "／届いた声 " + cellText(t.total, data.k)));

    var acts = (data.actions || []).filter(function (a) { return a.theme === t.theme; });
    var plan = acts.filter(function (a) { return a.state === "予定"; });
    var done = acts.filter(function (a) { return a.state !== "予定"; });

    box.appendChild(elm("h3", "vb-h", "届いた声（公開できる要約）"));
    if (!(t.summaries || []).length) {
      box.appendChild(elm("div", "vb-empty", "公開できる要約はまだありません。公開してよいと答えていただいた声だけを、要約にして載せています"));
    } else {
      t.summaries.forEach(function (s) {
        var row = elm("div", "vb-item");
        row.appendChild(elm("div", "vb-when", jpMonth(s.month)));
        row.appendChild(elm("div", "", s.text));
        box.appendChild(row);
      });
    }

    box.appendChild(elm("h3", "vb-h", "これまでの動き"));
    if (!done.length) box.appendChild(elm("div", "vb-empty", "まだ記録がありません"));
    done.forEach(function (a) { box.appendChild(actionRow(a)); });

    if (plan.length) {
      box.appendChild(elm("h3", "vb-h", "次の予定"));
      plan.forEach(function (a) { box.appendChild(actionRow(a)); });
    }
  }

  function actionRow(a) {
    var row = elm("div", "vb-item");
    row.appendChild(elm("div", "vb-when", [jpDay(a.date), a.kind, a.state].filter(String).join("・")));
    row.appendChild(elm("div", "", a.text));
    if (/^https?:\/\//i.test(String(a.url || ""))) { // http(s) 以外は開かない（表示側でももう一度確かめる）
      var link = elm("a", "vb-src", "出典を見る");
      link.href = a.url; link.target = "_blank"; link.rel = "noopener";
      row.appendChild(link);
    }
    return row;
  }

  // 盤面を描く。mount は空の要素（voices.html と index.html の #vb_wrap）
  global.renderVoiceBoard = function (mount) {
    if (!mount) return;
    mount.textContent = "読み込み中…";
    loadPublic().then(function (data) { board(data, mount); })
      .catch(function (e) {
        mount.textContent = "";
        mount.appendChild(elm("div", "vb-empty", "いまは表示できません（" + (e && e.message ? e.message : e) + "）。時間をおいて開き直してください"));
      });
  };
})(window);
