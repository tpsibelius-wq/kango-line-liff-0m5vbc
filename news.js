// 公開ページ「最新情報」。LIFF の中（index.html の ?v=news）と、LINEの外から見る news.html の両方が読む。
// 出しているのは題名・日付・リンクだけ（要約は作らない）。データは GAS の ?action=news_public（鍵なし）。
// window.NEWS_SAMPLE があればそれを使う（ローカルでの見た目確認）
(function (global) {
  "use strict";

  function elm(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  }

  function jpDay(ymd) {
    var m = String(ymd || "").match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
    return m ? Number(m[2]) + "/" + Number(m[3]) : String(ymd || "");
  }

  // Cloudflare の写しは無いので GAS から直接（voice_public と同じ作法）
  function loadPublic() {
    if (global.NEWS_SAMPLE) return Promise.resolve(global.NEWS_SAMPLE);
    var cfg = global.SITE_CONFIG || {};
    if (!cfg.API) return Promise.reject(new Error("取得先が未設定です（config.js の API）"));
    return fetch(cfg.API + (cfg.API.indexOf("?") >= 0 ? "&" : "?") + "action=news_public")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.error) throw new Error((j && j.error) || "最新情報を読めませんでした");
        return j;
      });
  }

  // 外から来たリンクは https のものだけ開く（画面側でももう一度確かめる）
  function linkRow(item, video) {
    var row = elm("div", "nw-item");
    row.appendChild(elm("div", "nw-when", jpDay(item.date)));
    if (/^https:\/\//i.test(String(item.url || ""))) {
      var a = elm("a", "nw-title", (video ? "▶ " : "") + item.title); // 動画は YouTube だと分かるように
      a.href = item.url; a.target = "_blank"; a.rel = "noopener";
      row.appendChild(a);
    } else {
      row.appendChild(elm("div", "", item.title));
    }
    return row;
  }

  function build(data, mount) {
    mount.innerHTML = "";
    var wrap = elm("div", "nw");

    if (data.note) wrap.appendChild(elm("div", "nw-note", data.note));

    var evs = data.events || [];
    if (evs.length) {
      wrap.appendChild(elm("h3", "nw-h", "次のイベント"));
      evs.slice(0, 3).forEach(function (e) {
        var row = elm("div", "nw-item");
        row.appendChild(elm("div", "nw-when", [e.date, e.place].filter(String).join("・")));
        row.appendChild(elm("div", "", e.name));
        var a = elm("a", "nw-apply", "申込みはこちら");
        a.href = (global.SITE_CONFIG || {}).LIFF_ID ? "https://liff.line.me/" + global.SITE_CONFIG.LIFF_ID : "index.html";
        a.target = "_blank"; a.rel = "noopener";
        row.appendChild(a);
        wrap.appendChild(row);
      });
    }

    // 出典はグループ（連盟・協会の新着／組織内候補の議員から／連盟・協会の動画／厚労省）ごとにまとめる
    var groups = [];
    (data.sections || []).forEach(function (s) {
      var name = s.group || "";
      var g = groups.filter(function (x) { return x.name === name; })[0];
      if (!g) { g = { name: name, list: [] }; groups.push(g); }
      g.list.push(s);
    });
    groups.forEach(function (g) {
      if (g.name) wrap.appendChild(elm("h3", "nw-h", g.name));
      g.list.forEach(function (s) {
        wrap.appendChild(elm("div", "nw-src", s.source));
        (s.items || []).forEach(function (it) { wrap.appendChild(linkRow(it, s.video)); });
      });
    });
    if (!(data.sections || []).length) {
      wrap.appendChild(elm("div", "nw-empty", "いまは新しい記事がありません。次の収集（毎週月曜の朝）をお待ちください"));
    }

    var acts = data.actions || [];
    if (acts.length) {
      wrap.appendChild(elm("h3", "nw-h", "連盟の動き"));
      acts.forEach(function (a) {
        var row = elm("div", "nw-item");
        row.appendChild(elm("div", "nw-when", [jpDay(a.date), a.kind, a.theme].filter(String).join("・")));
        row.appendChild(elm("div", "", a.text));
        if (/^https:\/\//i.test(String(a.url || ""))) {
          var link = elm("a", "nw-title", "出典を見る");
          link.href = a.url; link.target = "_blank"; link.rel = "noopener";
          row.appendChild(link);
        }
        wrap.appendChild(row);
      });
    }

    wrap.appendChild(elm("div", "nw-foot", "題名とリンクを自動で集めています。内容は各サイトでご確認ください"
      + (data.at ? "（" + jpDay(String(data.at).slice(0, 10)) + " 収集）" : "")));
    mount.appendChild(wrap);
  }

  // 最新情報を描く。mount は空の要素（news.html と index.html の #nw_wrap）
  global.renderNews = function (mount) {
    if (!mount) return;
    mount.textContent = "読み込み中…";
    loadPublic().then(function (data) { build(data, mount); })
      .catch(function (e) {
        mount.textContent = "";
        mount.appendChild(elm("div", "nw-empty", "いまは表示できません（" + (e && e.message ? e.message : e) + "）。時間をおいて開き直してください"));
      });
  };
})(window);
