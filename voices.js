// 公開ページ「届いた声」。LIFF の中（index.html の ?v=map）と、LINEの外から見る voices.html の両方が読む。
// 見せるのは「どんな声がどれだけ届いているか」だけ。段階（届いた→変わった）は内部の管理用なので出さない。
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

  function jpDay(ymd) {
    var d = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return d ? Number(d[2]) + "/" + Number(d[3]) : String(ymd || "");
  }
  function jpMonth(ym) {
    var m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
    return m ? m[1] + "年" + Number(m[2]) + "月" : "";
  }

  // 件数の表示。"<K" は人数が少ないので数を出さない
  function countText(v, k) {
    if (v === "<K") return k + "件未満";
    return (Number(v) || 0) + "件";
  }
  // 並べ替えと横棒の長さに使う数。"<K" は 0 と実数の間に置く
  function countNum(v) { return v === "<K" ? 0.5 : (Number(v) || 0); }

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

    wrap.appendChild(elm("div", "vb-legend",
      "件数が" + data.k + "件に満たないテーマは、書いた人が分からないように数を伏せています。"));

    // 件数の多い順。同じならデータの並び（テーマの決めた順）のまま
    var themes = (data.themes || []).map(function (t, i) { return { t: t, i: i, n: countNum(t.total) }; })
      .sort(function (a, b) { return (b.n - a.n) || (a.i - b.i); });
    var max = themes.reduce(function (m, x) { return Math.max(m, x.n); }, 0);

    var list = elm("div", "vb-list");
    themes.forEach(function (x) {
      var t = x.t;
      var row = elm("button", "vb-row" + (t.total === "<K" ? " few" : x.n ? "" : " zero"));
      row.type = "button";
      row.dataset.theme = t.theme;
      row.setAttribute("aria-label", t.theme + " " + countText(t.total, data.k));
      row.appendChild(elm("span", "vb-rname", t.theme));
      row.appendChild(elm("span", "vb-rn", countText(t.total, data.k)));
      var bar = elm("span", "vb-bar");
      var fill = document.createElement("i");
      // "<K" は実数が分からないので、あることだけ分かる短い棒にする
      fill.style.width = x.n ? (t.total === "<K" ? 8 : Math.max(4, Math.round(x.n / max * 100))) + "%" : "0";
      bar.appendChild(fill);
      row.appendChild(bar);
      row.onclick = function () { select(data, mount, t.theme); };
      list.appendChild(row);
    });
    wrap.appendChild(list);

    var detail = elm("div", "vb-detail");
    detail.id = "vb_detail";
    wrap.appendChild(detail);

    // 連盟の動き（公開している打ち手）。あるときだけ出す
    var acts = data.actions || [];
    if (acts.length) {
      var box = elm("div", "vb-acts");
      box.appendChild(elm("h3", "vb-h", "連盟の動き"));
      acts.forEach(function (a) { box.appendChild(actionRow(a)); });
      wrap.appendChild(box);
    }

    var foot = elm("div", "vb-foot");
    foot.textContent = "公開しているのは、個人や施設が分からない形にした要約と件数だけです。原文は連盟の担当だけが読みます。"
      + (data.at ? "（" + String(data.at).slice(0, 10) + " 時点）" : "");
    wrap.appendChild(foot);

    mount.appendChild(wrap);
    /* 「私も同じ」ボタンを付けるならテーマ行の中（今回は作らない） */
    // 最初は件数がいちばん多いテーマを開く。0件しか無ければ何も開かない
    var first = themes.filter(function (x) { return x.n > 0; })[0];
    select(data, mount, SEL || (first ? first.t.theme : ""));
  }

  function select(data, mount, theme) {
    SEL = theme;
    var box = mount.querySelector("#vb_detail");
    if (!box) return;
    var rows = mount.querySelectorAll(".vb-row");
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("sel", rows[i].dataset.theme === theme);
    box.innerHTML = "";
    var t = (data.themes || []).filter(function (x) { return x.theme === theme; })[0];
    if (!t) return;

    box.appendChild(elm("div", "vb-dt", t.theme));
    box.appendChild(elm("div", "vb-sub", "届いた声 " + countText(t.total, data.k)));
    box.appendChild(elm("h3", "vb-h", "届いた声（公開できる要約）"));
    if (!(t.summaries || []).length) {
      box.appendChild(elm("div", "vb-empty", "公開できる要約はまだありません。公開してよいと答えていただいた声だけを、要約にして載せています"));
      return;
    }
    var act = global.VOICE_ACTIONS || null; // LINE の中（LIFF）だけ。単独ページでは null＝表示のみ
    t.summaries.forEach(function (s) { // 新しい順（サーバーで並べ替え済み）
      var row = elm("div", "vb-item");
      row.appendChild(elm("div", "vb-when", jpMonth(s.month)));
      row.appendChild(elm("div", "", s.text));
      row.appendChild(likeRow(s, act));
      if (String(s.reply || "").trim()) {
        var rep = elm("div", "vb-reply");
        rep.appendChild(elm("span", "vb-reply-t", "連盟から"));
        rep.appendChild(elm("span", "", s.reply));
        row.appendChild(rep);
      }
      var kids = s.comments || [];
      if (kids.length) {
        var det = document.createElement("details");
        det.className = "vb-cmts";
        var sm = document.createElement("summary");
        sm.textContent = "意見 " + kids.length + "件";
        det.appendChild(sm);
        kids.forEach(function (c) {
          var ci = elm("div", "vb-cmt");
          ci.appendChild(elm("div", "vb-when", jpMonth(c.month)));
          ci.appendChild(elm("div", "", c.text));
          ci.appendChild(likeRow(c, act));
          det.appendChild(ci);
        });
        row.appendChild(det);
      }
      if (act && act.comment) {
        var cb = elm("button", "vb-write", "意見を書く");
        cb.onclick = function () { act.comment(s.ref, t.theme, s.text); };
        row.appendChild(cb);
      } else if (!act && !box.querySelector(".vb-inline-line")) {
        // 単独ページ: 押せないので、LINE で開く入口だけ出す（最初の要約に1つ）
        var a = elm("a", "vb-inline-line", "LINE で開くと「♥ 私も同じ」を押して、意見も書けます");
        a.href = (global.SITE_CONFIG && global.SITE_CONFIG.ADD_URL) || "go.html";
        a.target = "_blank"; a.rel = "noopener";
        row.appendChild(a);
      }
      box.appendChild(row);
    });
  }

  // 「♥ 私も同じ n」。LIFF の中はトグル、単独ページは表示のみ
  function likeRow(s, act) {
    var wrap = elm("div", "vb-likes");
    var n = Number(s.likes) || 0;
    if (!act || !act.like) {
      wrap.appendChild(elm("span", "vb-like ro", "♥ 私も同じ " + n));
      return wrap;
    }
    var on = !!(act.liked && act.liked[s.ref]);
    var b = elm("button", "vb-like" + (on ? " on" : ""), "♥ 私も同じ " + n);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.onclick = function () {
      if (b.disabled) return;
      var next = !on, before = n;
      n = Math.max(0, n + (next ? 1 : -1)); on = next;   // 押した瞬間に増減して、裏で送る
      b.textContent = "♥ 私も同じ " + n;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.disabled = true;
      act.like(s.ref, next).then(function (r) {
        if (r && typeof r.likes === "number") { n = r.likes; on = !!r.liked; }
        b.textContent = "♥ 私も同じ " + n;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }).catch(function () {                              // 失敗したら戻す
        n = before; on = !next;
        b.textContent = "♥ 私も同じ " + n;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }).then(function () { b.disabled = false; });
    };
    wrap.appendChild(b);
    return wrap;
  }

  function actionRow(a) {
    var row = elm("div", "vb-item");
    row.appendChild(elm("div", "vb-when", [jpDay(a.date), a.kind, a.theme].filter(String).join("・")));
    row.appendChild(elm("div", "", a.text));
    if (/^https?:\/\//i.test(String(a.url || ""))) { // http(s) 以外は開かない（表示側でももう一度確かめる）
      var link = elm("a", "vb-src", "出典を見る");
      link.href = a.url; link.target = "_blank"; link.rel = "noopener";
      row.appendChild(link);
    }
    return row;
  }

  // 一覧を描く。mount は空の要素（voices.html と index.html の #vb_wrap）
  // 送信のあとに描き直す（意見を書いたあとなど）
  global.reloadVoiceBoard = function (mount) { SEL = SEL; global.renderVoiceBoard(mount, SEL); };
  global.renderVoiceBoard = function (mount, keepTheme) {
    if (!mount) return;
    mount.textContent = "読み込み中…";
    loadPublic().then(function (data) { board(data, mount); if (keepTheme) select(data, mount, keepTheme); })
      .catch(function (e) {
        mount.textContent = "";
        mount.appendChild(elm("div", "vb-empty", "いまは表示できません（" + (e && e.message ? e.message : e) + "）。時間をおいて開き直してください"));
      });
  };
})(window);
