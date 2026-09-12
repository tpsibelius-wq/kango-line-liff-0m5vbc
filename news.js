// 公開ページ「最新情報」。LIFF の中（index.html の ?v=news）と、LINEの外から見る news.html の両方が読む。
// 出しているのは題名・日付・リンクだけ（要約は作らない）。データは Cloudflare の写し（/news）、無ければ GAS の ?action=news_public（鍵なし）。
// window.NEWS_SAMPLE があればそれを使う（ローカルでの見た目確認）
(function (global) {
  "use strict";

  // グループごとの色（バッジと左の帯）。色そのものは styles.css のトークン
  var GROUP_CLASS = {
    "連盟・協会の新着": "g-fed",
    "組織内候補の議員から": "g-diet",
    "連盟・協会の動画": "g-video",
    "厚労省（看護関連）": "g-gov",
    "連盟のInstagram": "g-ig",
  };
  var GROUP_ORDER = ["連盟・協会の新着", "組織内候補の議員から", "連盟・協会の動画", "厚労省（看護関連）", "連盟のInstagram"];

  function elm(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  }

  function dnum(ymd) {
    var m = String(ymd || "").match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : 0;
  }
  // 近い日は「今日・昨日・3日前」、8日以上前は「9/1」
  function whenText(ymd) {
    var t = dnum(ymd);
    if (!t) return String(ymd || "");
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var days = Math.round((today - t) / 86400000);
    if (days <= 0) return "今日";
    if (days === 1) return "昨日";
    if (days <= 7) return days + "日前";
    var m = String(ymd).match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
    return Number(m[2]) + "/" + Number(m[3]);
  }
  function isNew(ymd) {
    var t = dnum(ymd);
    return !!t && Date.now() - t <= 8 * 86400000;
  }
  function isHttps(url) { return /^https:\/\//i.test(String(url || "")); }

  // YouTube のリンクから動画IDを取り、サムネイルの URL を作る
  function ytThumb(url) {
    var u = String(url || "");
    var m = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/)
      || u.match(/\/shorts\/([A-Za-z0-9_-]{6,})/) || u.match(/\/embed\/([A-Za-z0-9_-]{6,})/);
    return m ? "https://i.ytimg.com/vi/" + m[1] + "/hqdefault.jpg" : "";
  }

  // Cloudflare の写し（/news）を先に読み、無い・読めないときは GAS から直接（GAS は応答に2〜5秒かかる）
  function loadPublic() {
    if (global.NEWS_SAMPLE) return Promise.resolve(global.NEWS_SAMPLE);
    var cfg = global.SITE_CONFIG || {};
    var urls = [];
    if (cfg.WORKER) urls.push(String(cfg.WORKER).replace(/\/$/, "") + "/news");
    if (cfg.API) urls.push(cfg.API + (cfg.API.indexOf("?") >= 0 ? "&" : "?") + "action=news_public");
    if (!urls.length) return Promise.reject(new Error("取得先が未設定です（config.js の API）"));
    var at = function (i) {
      return fetch(urls[i]).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || j.error) throw new Error((j && j.error) || "最新情報を読めませんでした");
        return j;
      }).catch(function (e) { return i + 1 < urls.length ? at(i + 1) : Promise.reject(e); });
    };
    return at(0);
  }

  // 出典の情報を item に持たせて1本の配列にする
  function flatten(data) {
    var out = [];
    (data.sections || []).forEach(function (s) {
      (s.items || []).forEach(function (it) {
        out.push({ date: it.date, title: it.title, url: it.url, pick: !!it.pick, image: it.image || "",
          source: s.source, group: s.group || "", video: !!s.video });
      });
    });
    return out;
  }
  function byNew(a, b) { return dnum(b.date) - dnum(a.date); }

  // ピックアップ: ★ が付いた行を優先。無ければ主な3グループから最新1件ずつ
  function pickUp(all) {
    var starred = all.filter(function (x) { return x.pick; }).sort(byNew);
    if (starred.length) return starred.slice(0, 3);
    var out = [];
    ["連盟・協会の新着", "組織内候補の議員から", "連盟・協会の動画"].forEach(function (g) {
      var top = all.filter(function (x) { return x.group === g; }).sort(byNew)[0];
      if (top) out.push(top);
    });
    return out.slice(0, 3);
  }

  // 大きいカード（ピックアップ・イベント）。カード全体がリンク
  function bigCard(x) {
    var card = isHttps(x.url) ? elm("a", "nw-card " + (GROUP_CLASS[x.group] || "g-fed")) : elm("div", "nw-card " + (GROUP_CLASS[x.group] || "g-fed"));
    if (card.tagName === "A") { card.href = x.url; card.target = "_blank"; card.rel = "noopener"; }
    var thumb = isHttps(x.image) ? x.image : x.video ? ytThumb(x.url) : "";
    if (thumb) {
      var im = document.createElement("img");
      im.className = "nw-thumb"; im.src = thumb; im.alt = ""; im.loading = "lazy";
      card.appendChild(im);
    }
    var head = elm("div", "nw-head");
    head.appendChild(elm("span", "nw-badge", x.source));
    if (isNew(x.date)) head.appendChild(elm("span", "nw-new", "NEW"));
    card.appendChild(head);
    card.appendChild(elm("div", "nw-ttl", (x.video ? "▶ " : "") + x.title));
    var meta = elm("div", "nw-meta");
    meta.appendChild(elm("span", "", whenText(x.date)));
    meta.appendChild(elm("span", "nw-go", x.video ? "見る ›" : "読む ›"));
    card.appendChild(meta);
    return card;
  }

  // 一覧の1行（題名 → 出典・日付）。動画と、画像のある行（Instagram）は左に小さなサムネイル
  function listRow(x) {
    var row = elm("div", "nw-row");
    var thumb = isHttps(x.image) ? x.image : x.video ? ytThumb(x.url) : "";
    if (thumb) {
      var im = document.createElement("img");
      im.className = "nw-row-thumb"; im.src = thumb; im.alt = ""; im.loading = "lazy";
      row.appendChild(im);
    }
    var body = elm("div", "nw-row-body");
    if (isHttps(x.url)) {
      var a = elm("a", "nw-row-ttl", (x.video ? "▶ " : "") + x.title);
      a.href = x.url; a.target = "_blank"; a.rel = "noopener";
      body.appendChild(a);
    } else {
      body.appendChild(elm("div", "nw-row-ttl", x.title));
    }
    body.appendChild(elm("div", "nw-row-meta", x.source + "・" + whenText(x.date)));
    row.appendChild(body);
    return row;
  }

  function build(data, mount) {
    mount.innerHTML = "";
    var wrap = elm("div", "nw");
    var all = flatten(data);

    if (data.note) wrap.appendChild(elm("div", "nw-note", data.note));

    // 1) 今週のピックアップ（大きいカード最大3枚）
    var picks = pickUp(all);
    if (picks.length) {
      wrap.appendChild(elm("h3", "nw-h", "今週のピックアップ"));
      var box = elm("div", "nw-pick");
      picks.forEach(function (x) { box.appendChild(bigCard(x)); });
      wrap.appendChild(box);
    }

    // 2) 次のイベント
    var ev = (data.events || [])[0];
    if (ev) {
      wrap.appendChild(elm("h3", "nw-h", "次のイベント"));
      var cfg = global.SITE_CONFIG || {};
      var c = elm("a", "nw-card g-event");
      c.href = cfg.LIFF_ID ? "https://liff.line.me/" + cfg.LIFF_ID : "index.html";
      c.target = "_blank"; c.rel = "noopener";
      var h = elm("div", "nw-head");
      h.appendChild(elm("span", "nw-badge", "イベント"));
      c.appendChild(h);
      c.appendChild(elm("div", "nw-ttl", ev.name));
      var m = elm("div", "nw-meta");
      m.appendChild(elm("span", "", [ev.date, ev.place].filter(String).join("・")));
      m.appendChild(elm("span", "nw-go", "申し込む ›"));
      c.appendChild(m);
      wrap.appendChild(c);
    }

    // 3) グループごとの一覧（最新3件。それ以上は「もっと見る」で開く）
    GROUP_ORDER.forEach(function (g) {
      var items = all.filter(function (x) { return x.group === g; }).sort(byNew);
      if (!items.length) return; // 0件のグループは見出しごと出さない
      wrap.appendChild(elm("h3", "nw-h", g));
      var list = elm("div", "nw-list " + (GROUP_CLASS[g] || ""));
      items.slice(0, 3).forEach(function (x) { list.appendChild(listRow(x)); });
      wrap.appendChild(list);
      if (items.length <= 3) return;
      var rest = elm("div", "nw-list " + (GROUP_CLASS[g] || ""));
      rest.style.display = "none";
      items.slice(3).forEach(function (x) { rest.appendChild(listRow(x)); });
      wrap.appendChild(rest);
      var label = "もっと見る（あと " + (items.length - 3) + " 件）";
      var more = elm("button", "nw-more", label);
      more.type = "button";
      more.onclick = function () {
        var open = rest.style.display === "none";
        rest.style.display = open ? "block" : "none";
        more.textContent = open ? "閉じる" : label;
      };
      wrap.appendChild(more);
    });
    if (!all.length) {
      wrap.appendChild(elm("div", "nw-empty", "いまは新しい記事がありません。次の収集（毎週月曜の朝）をお待ちください"));
    }

    // 4) 連盟の動き
    var actBox = null;
    (data.actions || []).forEach(function (a, i) {
      if (!i) {
        wrap.appendChild(elm("h3", "nw-h", "連盟の動き"));
        actBox = elm("div", "nw-list g-event");
        wrap.appendChild(actBox);
      }
      var row = elm("div", "nw-row");
      var body = elm("div", "nw-row-body");
      body.appendChild(elm("div", "nw-row-ttl", a.text));
      body.appendChild(elm("div", "nw-row-meta", [whenText(a.date), a.kind, a.theme].filter(String).join("・")));
      if (isHttps(a.url)) {
        var link = elm("a", "nw-row-src", "出典を見る ›");
        link.href = a.url; link.target = "_blank"; link.rel = "noopener";
        body.appendChild(link);
      }
      row.appendChild(body);
      actBox.appendChild(row);
    });

    wrap.appendChild(elm("div", "nw-foot", "題名とリンクを自動で集めています。内容は各サイトでご確認ください"
      + (data.at ? "（" + whenText(String(data.at).slice(0, 10)) + " 収集）" : "")));
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
