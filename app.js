// 静岡県看護連盟 公式LINE の画面（参加者・会員・管理者）。設定は config.js、見た目は styles.css
var LIFF_ID = (window.SITE_CONFIG || {}).LIFF_ID || "";
var API = (window.SITE_CONFIG || {}).API || "";

var TOKEN = "", STATE = null, TARGET = "", MODE = "user", VIEW = "", VIEW_DONE = false, A_IMG = "", A_RATIO = "", COPY_FROM = "";
var DBG = {};
function $(id){ return document.getElementById(id); }
var TODO_SCOPE = (function(){ try { return localStorage.getItem("kango_todo_scope") || "mine"; } catch (e) { return "mine"; } })();
var TOAST_T = null;
// 操作の結果は右下（スマホは下）に数秒出す。読み込み中などの途中経過（末尾「…」）は出さない
function toast(t){
  var box = $("toast"); if (!box){ box = document.createElement("div"); box.id = "toast"; document.body.appendChild(box); }
  box.textContent = t; box.classList.add("on");
  clearTimeout(TOAST_T); TOAST_T = setTimeout(function(){ box.classList.remove("on"); }, 4000);
}
function say(t){ $("msg").textContent = t; if (MODE === "admin" && t && !/…$/.test(t) && !/^こんにちは/.test(t)) toast(t); }
function showDbg(extra){ var d = $("dbg"); if (!d || !/[?&]dbg=1/.test(location.search)) return; /* 開発時だけ（?dbg=1） */ d.textContent = "mode=" + MODE + (extra ? " / " + extra : "") + (DBG.state ? " / state=" + DBG.state : ""); }
window.onerror = function(m, src, line){ say("エラー: " + m + " (line " + line + ")"); };
window.addEventListener("unhandledrejection", function(ev){ say("Promiseエラー: " + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason)); });

// 本文の語からテーマを仮に選ぶための対応表。key はテーマ名に含まれる語（テーマ名そのものは cfg.themes から受ける）
var VOICE_THEME_HINTS = [
  { key: "夜勤",         words: ["夜勤", "シフト", "休み", "有休", "有給"] },
  { key: "処遇",         words: ["給料", "給与", "手当", "賃上げ", "ベースアップ"] },
  { key: "人員配置",     words: ["人手", "人員", "忙し", "残業", "業務量"] },
  { key: "子育て",       words: ["子ども", "子供", "育児", "介護", "保育"] },
  { key: "教育",         words: ["研修", "資格", "キャリア", "教育"] },
  { key: "ハラスメント", words: ["ハラスメント", "パワハラ", "暴言", "セクハラ"] },
  { key: "ICT",          words: ["電子カルテ", "ICT", "DX", "システム", "タスク"] },
  { key: "地域",         words: ["訪問", "在宅", "地域"] },
  { key: "制度",         words: ["制度", "法律", "届出"] },
];

function api(action, payload){
  return READY.then(function(){
  var body = Object.assign({ action: action, token: TOKEN }, payload || {});
  // 二重実行防止の合言葉（Worker 経由でも GAS 直接でも同じ値。サーバーが6時間おぼえる）
  var isWrite = action === "liff_apply" || action === "liff_cancel" || action === "liff_voice" || action === "liff_join" || (action.indexOf("liff_admin_") === 0 && action !== "liff_admin_bootstrap");
  if (isWrite) body.idem = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  var send = function(url){
    // 25秒で中断する（応答が返らないまま画面が「保存中…」で止まらないように）。中断は失敗として扱う
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 25000) : null;
    var stop = function(){ if (timer) clearTimeout(timer); };
    return fetch(url, { method: "POST", body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined })
      .catch(function(){ throw new Error("通信に失敗しました。電波の良い場所でもう一度お試しください"); })
      .then(function(r){ return r.json().catch(function(){ throw new Error("サーバーの応答が読めませんでした。少し待ってからもう一度お試しください"); }); })
      .then(function(j){ stop(); return j; }, function(e){ stop(); throw e; });
  };
  // 申込・キャンセル・管理操作はWorkerが即時に受け付け、裏でGASへ渡す（配信などの結果はトークに届く）。Workerが使えないときはGASへ直接
  var viaWorker = !!WORKER && (action === "liff_apply" || action === "liff_cancel" || (action.indexOf("liff_admin_") === 0 && action !== "liff_admin_bootstrap" && action !== "liff_admin_ops" && action !== "liff_admin_delete_event")); // 運用と削除は GAS に直接
  var p = viaWorker
    ? send(WORKER).then(function(j){ if (j && j.error && /no snapshot|worker/.test(j.error)) throw new Error("worker"); return j; }).catch(function(){ return send(API); })
    : send(API);
  return p.then(function(j){
      if (j && j.error){
        // 本人確認トークンの期限切れ → 操作を退避してログインし直し、再読込後に自動で続きを実行
        if (String(j.error).indexOf("本人確認に失敗") >= 0 && !sessionStorage.getItem("relogin")){
          try { sessionStorage.setItem("relogin", "1"); sessionStorage.setItem("pending", JSON.stringify({ action: action, payload: payload || {}, mode: MODE })); } catch (e) {}
          say("しばらく時間が経ったため、本人確認をやり直します…");
          try { liff.logout(); } catch (e) {}
          liff.login({ redirectUri: location.href });
          return new Promise(function(){});
        }
        throw new Error(j.error);
      }
      cacheSave(j);
      return j;
    });
  });
}

// ---- 前回の画面をスマホ内に保存し、次回は開いた瞬間に表示（最新は裏で取り直して差し替える）----
// 保存するのは参加者・会員の自分の画面だけ。管理者の画面（友だちの個人情報）は端末に残さず、毎回サーバーの権限確認を待って描く。
// 共用の端末で別のLINE利用者が開いたときに前の人の内容を見せないよう、キーに本人の userId（ハッシュ）を入れる
var UID = ""; // liff.getDecodedIDToken().sub のハッシュ。本人確認が済むまで空
function uidHash(s){ var h = 5381, v = String(s); for (var i = 0; i < v.length; i++) h = ((h * 33) ^ v.charCodeAt(i)) >>> 0; return h.toString(36); }
function cacheKey(mode){ return "kango_state_" + mode + "_" + UID; }
function cacheSave(st){
  try {
    if (!st || !st.events || st.publicOnly) return;
    var mode = st.stats ? "admin" : (st.myApplies ? "user" : "");
    if (mode !== "user" || !UID) return;
    var copy = Object.assign({}, st); delete copy.done; delete copy.message; delete copy.serverMs; delete copy.pending;
    var key = cacheKey(mode);
    // 共用の端末に前の利用者の写しを残さない（自分の分だけにする）
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf("kango_state_user_") === 0 && k !== key) localStorage.removeItem(k);
    }
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), st: copy }));
  } catch (e) {}
}
function cacheLoad(mode){
  if (mode !== "user" || !UID) return null;
  try {
    var raw = localStorage.getItem(cacheKey(mode)); if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || !o.st || Date.now() - o.t > 24 * 3600 * 1000) return null;
    return o.st;
  } catch (e) { return null; }
}
// 旧版が端末に残した管理者の画面・利用者ごとに分かれていない写しを消す（一度きりの後始末）
try { localStorage.removeItem("kango_state_admin"); localStorage.removeItem("kango_state_user"); } catch (e) {}

// ---- 計測（画面下の薄い文字に出す）----
var TM = {};
function showTiming(st){
  var s = function(ms){ return (ms / 1000).toFixed(1) + "秒"; };
  showDbg("読込 " + s(TM.sdk || 0) + " / 初期化 " + s((TM.init || 0) - (TM.sdk || 0)) + " / 本人確認〜表示 " + s((TM.boot || 0) - (TM.init || 0))
    + (st && st.serverMs ? "（うちサーバー処理 " + s(st.serverMs) + "）" : "") + (st && st.fromEdge ? "（Cloudflare経由）" : "") + (FROM_CACHE ? " / 前回の画面を先に表示" : "") + (FROM_PUBLIC ? " / 案内を先に表示" : ""));
}
var FROM_CACHE = false;
var FROM_PUBLIC = false; // 公開写しで先に案内を出した
var FRESH = false;       // 本人分の最新データを表示済み
// 本人確認が済むまでAPI呼び出しを待たせる（前回画面のボタンを早く押しても大丈夫なように）
var READY_RESOLVE; var READY = new Promise(function(r){ READY_RESOLVE = r; });

// 再ログイン後に、退避しておいた操作を続きから実行
function resumePending(){
  var raw = null;
  try { raw = sessionStorage.getItem("pending"); sessionStorage.removeItem("pending"); } catch (e) {}
  if (!raw) return false;
  var p = null;
  try { p = JSON.parse(raw); } catch (e) { return false; }
  if (!p || !p.action) return false;
  say("続きを実行しています…");
  if (p.mode === "admin"){
    MODE = "admin"; $("hdr_t").textContent = "管理メニュー"; $("user_ui").style.display = "none";
    // liff_admin_ops の応答は管理状態ではない（message だけ）ので、そのまま描かず読み直す
    api(p.action, p.payload).then(function(st){
      if (p.action === "liff_admin_ops"){ say((st && st.message) || "続きを実行しました"); refreshAdmin(); }
      else renderAdmin(st);
    }, function(e){ say("エラー: " + e.message); });
  } else {
    api(p.action, p.payload).then(function(st){ render(st); if (st && st.done) showDone(st); }).catch(function(e){ say("エラー: " + e.message); });
  }
  return true;
}

function parseParams(){
  var out = { ev: "", p: "", v: "" };
  try {
    var raw = location.search || "";
    var m = raw.match(/[?&]liff\.state=([^&]*)/);
    var st = m ? decodeURIComponent(m[1]) : "";
    var pick = function(src, key){ var mm = String(src).match(new RegExp("(?:^|[?&/])" + key + "=([^&]*)")); return mm ? decodeURIComponent(mm[1]) : ""; };
    out.ev = pick(raw, "ev") || pick(st, "ev");
    out.p = pick(raw, "p") || pick(st, "p");
    out.v = pick(raw, "v") || pick(st, "v");
    DBG.state = st.slice(0, 80);
  } catch (e) { DBG.err = String(e); }
  return out;
}

function jpDate(ymd){
  if (!ymd) return "";
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (d.getMonth() + 1) + "月" + d.getDate() + "日（" + "日月火水木金土".charAt(d.getDay()) + "）";
}

function el(tag, cls, text){ var x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; }

function fillSelect(id, list, val){
  var s = $(id);
  if (s.options.length > 1) { if (val) s.value = val; return; }
  list.forEach(function(v){ var o = document.createElement("option"); o.value = v; o.textContent = v; s.appendChild(o); });
  if (val) s.value = val;
}

// ---- 起動データの高速経路（Cloudflare Workers）。3秒で返らない／エラーならGASへ切り替える ----
function fastBootstrap(action){
  if (!WORKER) return api(action);
  var ctrl = ("AbortController" in window) ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 3000) : null;
  return READY.then(function(){
    return fetch(WORKER, { method: "POST", body: JSON.stringify({ action: action, token: TOKEN }), signal: ctrl ? ctrl.signal : undefined })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j || j.error) throw new Error((j && j.error) || "worker");
        if (j.snapshotAt && Date.now() - new Date(j.snapshotAt).getTime() > 90 * 60 * 1000) throw new Error("stale"); // 写しの更新が止まっていたらGASから
        // 書いた直後は写しの読み出しが最大60秒古いことがある → 手元の方が新しければ手元を使い、30秒後にもう一度取る
        var loc = cacheLoad(MODE); var mine = loc && (loc.snapshotAt || loc.at); var theirs = j.snapshotAt || j.at;
        if (mine && theirs && new Date(theirs).getTime() < new Date(mine).getTime()){
          setTimeout(function(){ fastBootstrap(action).then(function(st){ if (MODE === "admin") renderAdmin(st); else render(st); }).catch(function(){}); }, 30000);
          return loc;
        }
        cacheSave(j); return j;
      });
  }).catch(function(){ return api(action); }).then(function(j){ if (timer) clearTimeout(timer); return j; });
}

function boot(){
  TM.sdk = performance.now();
  if (typeof liff === "undefined"){ say("LIFF SDKが読み込めませんでした。通信環境を確認して開き直してください"); return; }
  // 個人情報を含む前回の画面は、誰のものか分かってから（本人確認のあとで）出す。それまでは個人情報のない案内だけを先に出す
  var prm0 = parseParams();
  TARGET = prm0.ev; MODE = prm0.p === "admin" ? "admin" : "user"; VIEW = prm0.v || "";
  say("初期化中…");
  if (MODE === "user" && PUBLIC_PROMISE){
    PUBLIC_PROMISE.then(function(j){
      if (!j || !j.events || FRESH || STATE) return;
      FROM_PUBLIC = true;
      render(j);
      say("イベント案内を表示しました。本人確認中…");
    });
  }
  liff.init({ liffId: LIFF_ID }).then(function(){
    TM.init = performance.now();
    if (!liff.isLoggedIn()){ say("LINEログインへ移動します…"); liff.login({ redirectUri: location.href }); return; }
    TOKEN = liff.getIDToken();
    if (!TOKEN){ say("本人確認トークンが取得できませんでした。開き直してください"); return; }
    try { var dec = liff.getDecodedIDToken(); UID = dec && dec.sub ? uidHash(dec.sub) : ""; } catch (e) { UID = ""; }
    READY_RESOLVE();
    var prm = parseParams();
    TARGET = prm.ev || TARGET; MODE = prm.p === "admin" ? "admin" : "user";
    showDbg();
    try { sessionStorage.removeItem("relogin"); } catch (e) {}
    if (resumePending()) return;
    // 参加者・会員の画面だけ、本人のキャッシュを先に出す（管理者の画面はサーバーが管理権限を確かめてから）
    var cached = MODE === "user" ? cacheLoad("user") : null;
    if (cached){ FROM_CACHE = true; render(cached); say("前回の内容を表示しています。最新の情報を確認中…"); }
    else say("本人確認中…");
    var done = function(fn){ return function(st){ TM.boot = performance.now(); FRESH = true; fn(st); showTiming(st); }; };
    if (MODE === "admin"){
      $("hdr_t").textContent = "管理メニュー";
      $("user_ui").style.display = "none";
      fastBootstrap("liff_admin_bootstrap").then(done(renderAdmin)).catch(bootFail);
    } else {
      fastBootstrap("liff_bootstrap").then(done(render)).catch(bootFail);
    }
  }).catch(function(e){ say("LIFF初期化エラー: " + (e && e.message ? e.message : e)); });
}

// 読み込みに失敗したとき: 原因（オフラインか）を言い、押して再読み込みできるボタンを出す。電波が戻ったら自動で読み直す
function bootFail(e){
  say(navigator.onLine === false ? "通信できません（オフライン）。電波の良い場所でもう一度お試しください" : "エラー: " + (e && e.message ? e.message : e));
  var b = document.createElement("button"); b.className = "join"; b.textContent = "もう一度読み込む"; b.onclick = function(){ location.reload(); };
  $("msg").appendChild(b);
  // 管理者の画面が出せなかったときは、前回の内容（友だちの個人情報）も消す
  if (MODE === "admin"){ $("admin_ui").classList.remove("shown"); } // 権限の確認ができなかったら管理画面を閉じる（内容は端末に保存していない）
}
window.addEventListener("online", function(){ if (!FRESH) location.reload(); });

// textarea は内容に合わせて高さを変える（PC で案内文や文面の全文が見えるように。上限は画面の6割）
function autosizeTA(ta){
  if (!ta || ta.tagName !== "TEXTAREA") return;
  ta.style.height = "auto";
  var h = Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.6));
  var min = parseInt(getComputedStyle(ta).minHeight, 10) || 72;
  ta.style.height = Math.max(h, min) + "px";
}
function autosizeAll(){ Array.prototype.forEach.call(document.querySelectorAll("textarea"), autosizeTA); }
document.addEventListener("input", function(ev){ autosizeTA(ev.target); });

// 運用ボタン（点検・バックアップ・保持期間・外形監視・Webhook）。Worker を通さず GAS に直接
function adminOps(op, confirmMsg){
  if (confirmMsg && !confirm(confirmMsg)) return;
  var out = $("ops_out"); out.style.display = "block"; out.textContent = "実行中…（点検は10秒ほど）";
  api("liff_admin_ops", { op: op, arg: confirmMsg ? "yes" : "" }).then(function(j){
    out.textContent = (j.message ? j.message + "\n" : "") + (j.text || "");
    if (op === "retention_purge" || op === "member_bcast" || op === "resend") refreshAdmin();
  }).catch(function(e){ out.textContent = "エラー: " + e.message; });
}

// イベントの削除（申込の記録も消える。テスト以外は「受付中」を外して残すのが基本）
function adminDeleteEvent(){
  var n = $("a_ev").value; if (!n) return;
  var cur = curEvent(n); var cnt = cur ? Number(cur.count || (cur.applicants || []).length || 0) : 0;
  if (!confirm("イベント「" + n + "」を削除します。" + (cnt ? "申込 " + cnt + " 件の記録も消えます。" : "") + "元に戻せません。よろしいですか？")) return;
  if (cnt && !confirm("本当に削除しますか？（実際に開催したイベントは削除せず「受付中」を外して残すのがおすすめ）")) return;
  say("削除中…");
  api("liff_admin_delete_event", { ev: n, force: true }).then(function(st){ $("a_ev").value = ""; clearForm(); renderAdmin(st); say(st.message || "削除しました"); })
    .catch(function(e){ say("エラー: " + e.message); });
}

/* ---------- 参加者モード ---------- */

function switchToAdmin(){
  MODE = "admin";
  $("user_ui").style.display = "none";
  $("hdr_t").textContent = "管理メニュー";
  say("管理画面を読み込み中…");
  fastBootstrap("liff_admin_bootstrap").then(renderAdmin).catch(bootFail);
}

// イベントを友だちに転送（LINE内なら送り先を選ぶ画面、外のブラウザなら LINE の共有URL）
function shareEvent(e){
  var text = "【静岡県看護連盟】" + e.date + " " + e.name + (e.place ? "\n📍 " + e.place : "") + (e.liff ? "\n申込はこちら: " + e.liff : "");
  if (window.liff && liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")) liff.shareTargetPicker([{ type: "text", text: text }]).catch(function(){});
  else window.open("https://line.me/R/share?text=" + encodeURIComponent(text), "_blank");
}

function render(st){
  STATE = st;
  $("user_ui").style.display = "block";
  $("adminlink").style.display = st.isAdmin ? "block" : "none";
  showDbg("me=" + (st.me || "?") + " admin=" + (st.isAdmin ? "yes" : "no"));
  say("こんにちは、" + (st.user.name || "ゲスト") + "さん");
  renderMemberView(st);
  fillDatalist(st.memberNames);
  var ev = $("events"); ev.innerHTML = "";
  st.events.forEach(function(e){
    var c = el("div", "card");
    if (e.img){ var im = document.createElement("img"); im.loading = "lazy"; im.decoding = "async"; if (e.ratio) im.style.aspectRatio = e.ratio.replace(":", " / "); im.src = e.img; c.appendChild(im); }
    var b = el("div", "cb");
    b.appendChild(el("div", "t", e.name));
    b.appendChild(el("div", "m", "📅 " + e.date + " " + e.time));
    b.appendChild(el("div", "m", "📍 " + e.place));
    if (e.fee) b.appendChild(el("div", "m", "💰 参加費 " + e.fee));
    b.appendChild(el("div", "m", e.desc));
    if (e.mapUrl){ var a = el("a", "mapbtn", "📍 地図を開く"); a.href = e.mapUrl; a.target = "_blank"; a.rel = "noopener"; b.appendChild(a); }
    if (e.open){ var shb = el("a", "mapbtn", "📤 友だちに知らせる"); shb.href = "#"; if (e.mapUrl) shb.style.marginLeft = "14px"; shb.onclick = function(ev){ ev.preventDefault(); shareEvent(e); }; b.appendChild(shb); }
    if (e.applied){
      b.appendChild(el("span", "chip ok", "申込済み ✓"));
      if (e.calUrl){ var ca = el("a", "mapbtn", "📆 カレンダーに追加"); ca.href = e.calUrl; ca.target = "_blank"; ca.rel = "noopener"; b.appendChild(ca); }
      b.appendChild(document.createElement("br"));
      var ed = el("button", "cancel", "内容を変更する"); ed.style.marginRight = "16px";
      ed.onclick = function(){ openForm(e, true); };
      b.appendChild(ed);
      var cx = el("button", "cancel", "キャンセルする");
      cx.onclick = function(){
        if (confirm(e.name + " の申込をキャンセルしますか？")) api("liff_cancel", { ev: e.name }).then(render).catch(function(er){ say("エラー: " + er.message); });
      };
      b.appendChild(cx);
    } else if (!e.open){
      b.appendChild(el("span", "chip ng", "受付終了"));
    } else {
      var bt = el("button", "join", "参加する" + (e.deadline ? "（締切" + e.deadline + "）" : ""));
      bt.onclick = function(){ openForm(e); };
      b.appendChild(bt);
    }
    c.appendChild(b); ev.appendChild(c);
  });
  var pf0 = st.prefill || {}; // 申込歴がない人は空
  fillSelect("f_kubun", st.kubunList, pf0.kubun);
  fillSelect("f_shokuba", st.shokubaList, pf0.shokuba);
  fillSelect("f_kikkake", st.keiroList, pf0.kikkake);
  $("f_name").value = pf0.name || $("f_name").value;
  $("f_contact").value = st.prefill.contact || $("f_contact").value;
  $("f_shokai").value = st.prefill.shokai || $("f_shokai").value;
  var h = $("hist"); h.innerHTML = "";
  if (!st.history.length){ h.textContent = "まだ申込はありません"; }
  st.history.forEach(function(x){
    var row = el("div", "hist", x.event + (x.eventDate ? "　" + x.eventDate : "") + "\n申込 " + x.at + (x.cancelled ? " … キャンセル済み" : " … 申込済み✓") + (x.dohanCount ? "　同伴" + x.dohanCount + "名" : ""));
    row.style.whiteSpace = "pre-wrap";
    if (x.calUrl){ row.appendChild(document.createElement("br")); var a2 = el("a", "mapbtn", "📆 カレンダーに追加"); a2.href = x.calUrl; a2.target = "_blank"; a2.rel = "noopener"; row.appendChild(a2); }
    h.appendChild(row);
  });
  $("formbox").style.display = "none";
  $("done").style.display = "none";
  var tgt = STATE.events.filter(function(e){ return e.name === TARGET && e.open && !e.applied; })[0];
  if (tgt) openForm(tgt);
  TARGET = "";
  applyUserView(st);
}

// メニューの「現場の声を聞かせてください」（?v=voice）「届いた声と動き」（?v=map）。ふだんの画面を隠して1つだけ出す
var MAP_DONE = false;
var NEWS_DONE = false;
function applyUserView(st){
  if (VIEW === "qr") VIEW = "ref"; // 旧「自分のQR」は紹介の画面にまとめた
  var v = ["voice", "map", "news", "join", "ref"].indexOf(VIEW) >= 0 ? VIEW : "";
  var hide = ["events", "hist_h", "hist", "adminlink"];
  if (v && v !== "ref") hide.push("ref_panel");
  if (v) hide.forEach(function(id){ var x = $(id); if (x) x.style.display = "none"; });
  [["voice_ui", "voice"], ["map_ui", "map"], ["news_ui", "news"], ["join_ui", "join"]].forEach(function(p){
    var x = $(p[0]); if (x) x.style.display = v === p[1] ? "block" : "none";
  });
  if (v === "voice"){ $("hdr_t").textContent = "現場の声を聞かせてください"; setupVoiceForm(st); }
  if (v === "map"){
    $("hdr_t").textContent = "届いた声";
    say("テーマごとに、届いた声の件数と要約が見られます");
    if (!MAP_DONE){ MAP_DONE = true; setupVoiceActions(); renderVoiceBoard($("vb_wrap")); }
  }
  if (v === "news"){
    $("hdr_t").textContent = "最新情報";
    say("連盟・協会のサイトから自動で集めています");
    if (!NEWS_DONE){ NEWS_DONE = true; renderNews($("nw_wrap")); }
  }
  if (v === "join"){ $("hdr_t").textContent = "一緒に活動する・入会"; setupJoinForm(st); }
  if (v === "ref"){
    $("hdr_t").textContent = "紹介する";
    var member = !!st.isMember;
    $("ref_panel").style.display = member ? "block" : "none";
    $("ref_guest").style.display = member ? "none" : "block";
    if (member){
      showMyQr("myqr");
      say("あなた専用の QR と紹介文です");
    } else {
      say("紹介は連盟会員の機能です");
    }
  }
}

// ---- 現場の声のフォーム（?v=voice）----
var V_THEMES = [], V_AUTO = {}, V_OFF = {}, V_KUBUN = "", V_WANT = "", V_FORM_DONE = false, V_SUGGEST_T = null;

// 押せるチップ（テーマは複数、区分は1つ）
function chipBox(id, list, onPick){
  var box = $(id); box.innerHTML = "";
  (list || []).forEach(function(v){
    var c = el("span", "chip btn", v);
    c.setAttribute("role", "button"); c.tabIndex = 0;
    c.dataset.v = v;
    var pick = function(){ onPick(v); };
    c.onclick = pick;
    c.onkeydown = function(ev){ if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); pick(); } };
    box.appendChild(c);
  });
}
function paintChips(id, isOn, isAuto){
  Array.prototype.forEach.call($(id).querySelectorAll(".chip"), function(c){
    var v = c.dataset.v;
    c.classList.toggle("sel", isOn(v));
    c.classList.toggle("auto", !!(isAuto && isAuto(v)));
  });
}
function paintVoiceThemes(){ paintChips("v_themes", function(t){ return V_THEMES.indexOf(t) >= 0; }, function(t){ return V_AUTO[t]; }); }

// 画面に表示している「声の取り扱い」の版。HTML の #v_pv に書いた文言と同じものを送る
var VOICE_POLICY_SHOWN = (function(){ try { return (document.getElementById("v_pv") || {}).textContent.trim(); } catch (e) { return ""; } })();
// 意見の同意文の版。画面（#cm_pv）に書いた文言をそのまま送る
var COMMENT_POLICY_SHOWN = (function(){ try { return (document.getElementById("cm_pv") || {}).textContent.trim(); } catch (e) { return ""; } })();

function setupVoiceForm(st){
  if (V_FORM_DONE) return; // 作るのは1回だけ（送信のあとの再描画で選んだテーマが消えないように）
  V_FORM_DONE = true;
  var cfg = (st && st.voice) || {};
  // 版は画面に書いてある文言（HTML の #v_pv）をそのまま使う。サーバーの現行版と違えば送信は断られる
  if (cfg.policyVersion && cfg.policyVersion !== VOICE_POLICY_SHOWN) {
    $("v_pv").textContent = VOICE_POLICY_SHOWN + "（サーバーは " + cfg.policyVersion + "。画面を再読み込みしてください）";
  }
  fillSelect("v_shokuba", st.shokubaList || [], "");
  chipBox("v_want", cfg.wants || [], function(v){
    V_WANT = V_WANT === v ? "" : v;
    paintChips("v_want", function(x){ return x === V_WANT; });
  });
  chipBox("v_themes", cfg.themes || [], function(t){
    var i = V_THEMES.indexOf(t);
    if (i >= 0){ V_THEMES.splice(i, 1); delete V_AUTO[t]; V_OFF[t] = true; } // 外したものは自動で選び直さない
    else { V_THEMES.push(t); delete V_AUTO[t]; delete V_OFF[t]; }
    paintVoiceThemes();
  });
  chipBox("v_kubun", st.kubunList || [], function(v){
    V_KUBUN = V_KUBUN === v ? "" : v;
    paintChips("v_kubun", function(x){ return x === V_KUBUN; });
  });
  var ta = $("v_body");
  ta.addEventListener("input", function(){
    $("v_count").textContent = ta.value.length + " / 2000字";
    clearTimeout(V_SUGGEST_T);
    V_SUGGEST_T = setTimeout(suggestVoiceThemes, 1500); // 打ち終わったころに候補を出す
  });
  ta.addEventListener("change", suggestVoiceThemes);
  say("現場の声を聞かせてください");
}

// 本文の語からテーマを仮に選ぶ。すでに選ばれているもの・利用者が外したものは触らない
function suggestVoiceThemes(){
  clearTimeout(V_SUGGEST_T);
  var text = $("v_body").value || "";
  if (!text) return;
  var themes = ((STATE && STATE.voice) || {}).themes || [];
  var added = false;
  VOICE_THEME_HINTS.forEach(function(h){
    if (!h.words.some(function(w){ return text.indexOf(w) >= 0; })) return;
    var t = themes.filter(function(x){ return x.indexOf(h.key) >= 0; })[0];
    if (!t || V_THEMES.indexOf(t) >= 0 || V_OFF[t]) return;
    V_THEMES.push(t); V_AUTO[t] = true; added = true;
  });
  if (added) paintVoiceThemes();
}

// ---- 届いた声の盤面（?v=map）で押せるようにする。単独ページ（voices.html）では VOICE_ACTIONS を作らない＝表示だけ ----
var V_LIKED = {};      // 自分が押した ref
function setupVoiceActions(){
  window.VOICE_ACTIONS = {
    liked: V_LIKED,
    like: function(ref, on){
      return api("liff_like", { ref: ref, on: on }).then(function(j){
        var r = (j && j.like) || {};
        if (r.liked) V_LIKED[ref] = 1; else delete V_LIKED[ref];
        return r;
      });
    },
    comment: function(ref, theme, parentText){ openCommentForm(ref, theme, parentText); },
  };
  // 自分が押した分を取り、ボタンの状態に反映する（読み取りだけ）
  api("liff_like_state", {}).then(function(j){
    (j && j.mine ? j.mine : []).forEach(function(r){ V_LIKED[r] = 1; });
    if (MAP_DONE) reloadVoiceBoard($("vb_wrap"));
  }).catch(function(){});
}

// 意見を書く（LIFF の中だけ）。要約せず、そのまますぐ公開される
var C_PARENT = "";
function openCommentForm(ref, theme, parentText){
  C_PARENT = ref;
  $("cm_parent").textContent = parentText || "";
  $("cm_theme").textContent = theme || "";
  $("cm_text").value = ""; $("cm_count").textContent = "0 / 300字";
  $("cm_consent").checked = false;
  fillSelect("cm_kubun", (STATE && STATE.kubunList) || [], "");
  $("cm_box").style.display = "block";
  $("cm_box").scrollIntoView({ behavior: "smooth" });
}
function closeCommentForm(){ $("cm_box").style.display = "none"; C_PARENT = ""; }
function countComment(){ $("cm_count").textContent = ($("cm_text").value || "").length + " / 300字"; }
function sendComment(){
  var d = { parent: C_PARENT, text: $("cm_text").value.trim(), kubun: $("cm_kubun").value,
            consent: $("cm_consent").checked, policyVersion: COMMENT_POLICY_SHOWN };
  if (!d.parent){ alert("どの声への意見か分かりませんでした。開き直してください"); return; }
  if (!d.text){ alert("意見を書いてください"); return; }
  if (d.text.length > 300){ alert("意見は300字までです"); return; }
  if (!d.kubun){ alert("区分を選んでください"); return; }
  if (!d.consent){ alert("「そのまますぐに公開される」ことへの同意をお願いします"); return; }
  $("cm_send").disabled = true; say("送信中…");
  api("liff_comment", { data: d }).then(function(st){
    $("cm_send").disabled = false;
    closeCommentForm();
    var done = st && st.commentDone;
    say((done && done.message) || "意見を送りました");
    if (done && !done.held) reloadVoiceBoard($("vb_wrap"));
  }).catch(function(e){ $("cm_send").disabled = false; say("エラー: " + e.message); });
}

// ---- 音声入力。使える端末はその場で認識し、使えない端末はキーボードのマイクへ案内する ----
var V_REC = null, V_REC_ON = false;
function speechCtor(){ return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

function appendVoiceText(t){
  var ta = $("v_body");
  var s = String(t || "").trim();
  if (!s) return;
  ta.value = ta.value ? ta.value.replace(/\s*$/, "") + "\n" + s : s;
  $("v_count").textContent = ta.value.length + " / 2000字";
}
function micButton(on){
  var b = $("v_mic");
  b.classList.toggle("on", on);
  b.textContent = on ? "● 聞いています… 押すと止める" : "🎤 話して入力";
}
function micError(msg){
  var e = $("v_mic_err"); e.textContent = msg; e.style.display = "block";
  $("v_mic_note").classList.add("on");
  stopVoiceMic();
}
function stopVoiceMic(){
  V_REC_ON = false;
  if (V_REC){ try { V_REC.stop(); } catch (e) {} }
  micButton(false);
  $("v_interim").style.display = "none"; $("v_interim").textContent = "";
  suggestVoiceThemes();
}

function toggleVoiceMic(){
  var C = speechCtor();
  if (!C){ // iOS の LINE など。キーボードのマイクに案内する
    $("v_mic_note").classList.add("on");
    $("v_body").focus();
    return;
  }
  if (V_REC_ON){ stopVoiceMic(); return; }
  try { V_REC = new C(); } catch (e) { micError("この端末では音声入力を使えませんでした。下の方法でお願いします"); return; }
  V_REC.lang = "ja-JP"; V_REC.interimResults = true; V_REC.continuous = true;
  V_REC.onresult = function(ev){
    var fixed = "", interim = "";
    for (var i = ev.resultIndex; i < ev.results.length; i++){
      var r = ev.results[i];
      if (r.isFinal) fixed += r[0].transcript; else interim += r[0].transcript;
    }
    if (fixed) appendVoiceText(fixed);
    var box = $("v_interim");
    box.textContent = interim;
    box.style.display = interim ? "block" : "none";
  };
  V_REC.onerror = function(ev){
    var kind = ev && ev.error;
    micError(kind === "not-allowed" || kind === "service-not-allowed"
      ? "マイクの使用が許可されませんでした。下の方法でお願いします"
      : "音声入力が止まりました。もう一度押すか、下の方法でお願いします");
  };
  V_REC.onend = function(){ if (V_REC_ON) stopVoiceMic(); }; // 無音で終わったとき
  try { V_REC.start(); } catch (e) { micError("音声入力を始められませんでした。下の方法でお願いします"); return; }
  V_REC_ON = true;
  micButton(true);
  $("v_mic_err").style.display = "none";
  $("v_mic_note").classList.remove("on");
}

function sendVoice(){
  var cfg = (STATE && STATE.voice) || {};
  if (V_REC_ON) stopVoiceMic();
  var d = { kubun: V_KUBUN, shokuba: $("v_shokuba").value, area: $("v_area").value.trim(),
            themes: V_THEMES.slice(), body: $("v_body").value.trim(), want: V_WANT,
            consentRecord: $("v_c1").checked, consentPublic: $("v_c2").checked, consentReply: $("v_c3").checked,
            policyVersion: VOICE_POLICY_SHOWN }; // 画面に表示した版をそのまま送る（表示と違う版で同意させない）
  if (!d.kubun){ alert("区分を選んでください"); return; }
  if (!d.themes.length){ alert("テーマを1つ以上選んでください"); return; }
  if (!d.body){ alert("声の内容を書いてください"); return; }
  if (!d.consentRecord){ alert("「担当が読み、記録する」への同意をお願いします"); return; }
  $("v_send").disabled = true;
  say("送信中…");
  api("liff_voice", { data: d }).then(function(st){
    $("v_send").disabled = false;
    render(st);
    if (st.duplicate){ say(st.message || "この操作は既に受け付けています"); return; } // 二重送信（同じ idem）
    showVoiceDone(st);
  }).catch(function(e){
    $("v_send").disabled = false;
    // 同意文の版が変わっていたら、そのまま送り直せないので画面を読み直す
    if (/再読み込み/.test(e.message)){ say(e.message); setTimeout(function(){ location.reload(); }, 3000); return; }
    say("エラー: " + e.message);
  });
}

// ---- 一緒に活動する（?v=join）----
var J_WANT = "", J_KUBUN = "", J_CONTACT = "", J_FORM_DONE = false;
function setupJoinForm(st){
  if (J_FORM_DONE) return;
  J_FORM_DONE = true;
  var cfg = (st && st.join) || {};
  $("j_intro").textContent = cfg.intro || "";
  var ev = (st.events || []).filter(function(e){ return e.open; })[0];
  if (ev){
    var box = $("j_next"); box.style.display = "block"; box.innerHTML = "";
    box.appendChild(el("div", "t", "次の予定: " + ev.name));
    box.appendChild(el("div", "m", "📅 " + ev.date + " " + ev.time + (ev.place ? "　📍 " + ev.place : "")));
    var b = el("button", "cancel", "このイベントの申込みを見る");
    b.onclick = function(){ VIEW = ""; TARGET = ev.name; render(STATE); };
    box.appendChild(b);
  }
  chipBox("j_want", cfg.wants || [], function(v){ J_WANT = J_WANT === v ? "" : v; paintChips("j_want", function(x){ return x === J_WANT; }); });
  chipBox("j_kubun", st.kubunList || [], function(v){ J_KUBUN = J_KUBUN === v ? "" : v; paintChips("j_kubun", function(x){ return x === J_KUBUN; }); });
  chipBox("j_contact", cfg.contacts || [], function(v){ J_CONTACT = J_CONTACT === v ? "" : v; paintChips("j_contact", function(x){ return x === J_CONTACT; }); });
  J_CONTACT = (cfg.contacts || [])[0] || "";
  paintChips("j_contact", function(x){ return x === J_CONTACT; });
  say("一緒に活動する・入会");
}

function sendJoin(){
  if (!J_WANT){ alert("希望を選んでください"); return; }
  if (!J_KUBUN){ alert("区分を選んでください"); return; }
  $("j_send").disabled = true;
  say("送信中…");
  api("liff_join", { data: { want: J_WANT, kubun: J_KUBUN, note: $("j_note").value.trim(), contact: J_CONTACT } }).then(function(st){
    $("j_send").disabled = false;
    render(st);
    if (st.duplicate){ say(st.message || "この操作は既に受け付けています"); return; }
    var box = $("j_done"); box.innerHTML = "";
    box.appendChild(el("div", "t", "ありがとうございます"));
    box.appendChild(el("div", "m", "担当から LINE でご連絡します（2〜3日以内）。"));
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth" });
    J_WANT = ""; $("j_note").value = "";
    paintChips("j_want", function(){ return false; });
    say("受け付けました");
  }).catch(function(e){ $("j_send").disabled = false; say("エラー: " + e.message); });
}

function showVoiceDone(st){
  var dn = st && st.voiceDone;
  if (!dn) return;
  V_THEMES = []; V_AUTO = {}; V_OFF = {}; V_KUBUN = ""; V_WANT = "";
  $("v_body").value = ""; $("v_area").value = ""; $("v_count").textContent = "0 / 2000字";
  $("v_c1").checked = false; $("v_c2").checked = false;
  $("v_mic_err").style.display = "none"; $("v_mic_note").classList.remove("on");
  paintVoiceThemes();
  paintChips("v_kubun", function(){ return false; });
  paintChips("v_want", function(){ return false; });
  var box = $("v_done");
  box.innerHTML = "";
  box.appendChild(el("div", "t", "受け取りました（受付番号 " + dn.no + "）"));
  box.appendChild(el("div", "m", dn.reply
    ? "確認のメッセージがまもなくトークに届きます。このテーマに動きがあれば、LINEでお知らせします。"
    : "確認のメッセージがまもなくトークに届きます。"));
  var b = el("button", "join", "届いた声を見る");
  b.onclick = function(){ VIEW = "map"; applyUserView(STATE); window.scrollTo({ top: 0 }); };
  box.appendChild(b);
  box.style.display = "block";
  box.scrollIntoView({ behavior: "smooth" });
  say("声をお預かりしました");
}

function openForm(e, edit){
  var f = $("formbox");
  f.dataset.ev = e.name;
  $("ftitle").textContent = e.name + (edit ? " の申込内容を変更" : " への参加申込");
  $("ffee").textContent = (e.fee ? "💰 参加費 " + e.fee + "　" : "") + "📅 " + e.date + " " + e.time;
  var pf = STATE.prefill || {};
  var my = edit && STATE.myApplies ? STATE.myApplies[e.name] : null;
  var src = my || pf;
  $("f_name").value = pf.name || $("f_name").value;
  fillSelect("f_kubun", STATE.kubunList, ""); $("f_kubun").value = src.kubun || "";
  fillSelect("f_shokuba", STATE.shokubaList || [], ""); $("f_shokuba").value = src.shokuba || "";
  $("f_contact").value = src.contact || "";
  fillSelect("f_kikkake", STATE.keiroList, ""); $("f_kikkake").value = src.kikkake || "";
  $("f_shokai").value = src.shokai || "";
  $("f_dohan").value = src.dohan || "";
  $("f_dohan_count").value = String(src.dohanCount || 0);
  $("f_memo").value = my ? (my.memo || "") : "";
  $("f_doui").checked = !!edit;
  // 2回目以降（氏名・連絡先が分かっている）はクイック申込を優先
  var canQuick = !edit && !!pf.name && !!pf.contact && !!pf.kubun;
  $("quick").style.display = canQuick ? "block" : "none";
  $("full").style.display = canQuick ? "none" : "block";
  if (canQuick){
    $("q_summary").textContent = pf.name + (pf.kubun ? "（" + pf.kubun + "）" : "") + "／" + pf.contact;
    $("q_dohan_count").value = "0"; $("q_dohan").value = ""; $("q_memo").value = ""; $("q_doui").checked = false;
  }
  f.style.display = "block";
  f.scrollIntoView({ behavior: "smooth" });
}

function showFull(){ $("quick").style.display = "none"; $("full").style.display = "block"; }

function sendApply(fromQuick){
  var pf = STATE.prefill || {};
  var d = fromQuick
    ? { name: pf.name, kubun: pf.kubun || "", shokuba: pf.shokuba || "", contact: pf.contact, kikkake: pf.kikkake || "", shokai: pf.shokai || "",
        dohanCount: $("q_dohan_count").value, dohan: $("q_dohan").value, memo: $("q_memo").value, doui: $("q_doui").checked }
    : { name: $("f_name").value, kubun: $("f_kubun").value, shokuba: $("f_shokuba").value, contact: $("f_contact").value,
        kikkake: $("f_kikkake").value, shokai: $("f_shokai").value,
        dohanCount: $("f_dohan_count").value, dohan: $("f_dohan").value, memo: $("f_memo").value, doui: $("f_doui").checked };
  if (!String(d.name || "").trim()){ alert("お名前を入力してください"); return; }
  if (!String(d.contact || "").trim()){ alert("連絡先を入力してください"); return; }
  if (!String(d.kubun || "").trim()){ alert("区分を選んでください"); showFull(); return; }
  if (!String(d.kubun || "").trim()){ alert("区分を選んでください"); showFull(); return; }
  var ct = String(d.contact).trim();
  var looksOk = ct.replace(/\D/g, "").length >= 10 || ct.indexOf("@") > 0;
  if (!looksOk && !confirm("連絡先「" + ct + "」は電話番号・メールアドレスとして読めません。この内容で送りますか？")) return;
  if (!d.doui){ alert("同意のチェックをお願いします"); return; }
  var btns = ["send", "q_send"];
  btns.forEach(function(id){ $(id).disabled = true; });
  say("送信中…");
  api("liff_apply", { ev: $("formbox").dataset.ev, data: d }).then(function(st){
    btns.forEach(function(id){ $(id).disabled = false; });
    render(st);
    showDone(st);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }).catch(function(e){ btns.forEach(function(id){ $(id).disabled = false; }); say("エラー: " + e.message); });
}

function showDone(st){
  var dn = st.done;
  if (!dn) return;
  var e = STATE.events.filter(function(x){ return x.name === dn.event; })[0];
  var my = STATE.myApplies ? STATE.myApplies[dn.event] : null;
  // pending＝Cloudflare が受付を預かった段階（台帳への確定はこのあと）。確定していないものを「完了」と書かない
  var pend = !!st.pending;
  $("done_title").textContent = pend ? (dn.isUpdate ? "変更を受け付けました" : "受付を送りました") : (dn.isUpdate ? "申込内容を変更しました" : "申込完了！ありがとうございます");
  var lines = ["【" + dn.event + "】"];
  if (e){ lines.push("📅 " + e.date + " " + e.time, "📍 " + e.place); if (e.fee) lines.push("💰 参加費 " + e.fee); }
  if (my && my.dohanCount > 0) lines.push("👥 同伴 " + my.dohanCount + "名" + (my.dohan ? "（" + my.dohan + "）" : ""));
  lines.push("", pend
    ? "確定すると、確認のメッセージがLINEのトークに届きます（ふつうは数秒）。届かないときはこの画面を開き直すか、担当にご連絡ください。変更・キャンセルはこの画面からできます。"
    : "確認メッセージがまもなくトークに届きます。変更・キャンセルはこの画面からいつでもできます。");
  $("done_body").textContent = lines.join("\n");
  var cal = $("done_cal");
  if (e && e.calUrl){ cal.href = e.calUrl; cal.style.display = "inline-block"; } else { cal.style.display = "none"; }
  $("done").style.display = "block";
  say("こんにちは、" + (st.user.name || "ゲスト") + "さん");
}

// ---- 会員向け: 紹介パネルを上に、紹介した人の状況（名前と段階だけ）----
function renderMemberView(st){
  var rp = $("ref_panel"), rl = $("ref_list");
  if (!rp || !rl) return;
  if (st.isMember){
    $("hdr_t").textContent = "会員メニュー";
    rp.style.display = "block";
    var ui = $("user_ui");
    if (rp.previousElementSibling !== $("done")) ui.insertBefore(rp, $("done").nextSibling);
    rl.style.display = "block"; rl.innerHTML = "";
    rl.appendChild(el("div", "t", "あなたが紹介した人の状況"));
    var list = st.referrals || [];
    if (!list.length){ rl.appendChild(el("small", "", "まだいません。紹介文を送るか、QRを見せて登録してもらってください（申込のときに「ご紹介者」にあなたの名前を入れてもらうと、ここに出ます）")); }
    else list.forEach(function(r){ rl.appendChild(el("div", "", "・" + r.name + " ・ " + r.status + (r.updated ? "（更新 " + r.updated + "）" : ""))); });
    var b = st.ranking;
    if (b && b.top && b.top.length){
      rl.appendChild(el("div", "t", "🏅 紹介ランキング（友だち／加入）"));
      b.top.forEach(function(r, i){ rl.appendChild(el("div", "", (i + 1) + ". " + r.name + " " + r.count + "人／加入 " + r.joined)); });
      if (b.myRank) rl.appendChild(el("small", "", "あなた: " + b.myRank + "位（友だち " + b.mine.count + "人／加入 " + b.mine.joined + "）"));
      else rl.appendChild(el("small", "", "あなたの紹介はまだ集計されていません。申込のとき「ご紹介者」にあなたの名前を入れてもらうと数えられます"));
    }
  } else {
    rl.style.display = "none";
    rp.style.display = "none"; // 紹介は会員の機能。未加入者には見せない
  }
  if (VIEW && !VIEW_DONE){
    VIEW_DONE = true;
    if (VIEW === "share") setTimeout(shareReferral, 300);
    if (["voice", "map", "news", "join", "ref", "qr"].indexOf(VIEW) >= 0) return; // 出し分けは applyUserView
    if (!st.isMember) return;
    setTimeout(function(){ rp.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  }
}

// ---- イベント当日の道具（受付名簿の印刷・申込QR）----
function escHtml(v){ return String(v == null ? "" : v).replace(/[&<>"]/g, function(ch){ return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]; }); }
function logoImg(){ return "<img src='" + new URL("assets/logo.svg", location.href).href + "' style='height:34px;float:left;margin:0 12px 6px 0'>"; }
function openPrintWindow(html){
  var w = window.open("", "_blank");
  if (!w){ alert("印刷用の画面を開けませんでした。PCのブラウザで開いてください"); return null; }
  w.document.open(); w.document.write(html); w.document.close();
  return w;
}
// 受付名簿: 氏名・会社・同伴・連絡先・メモとチェック欄。キャンセルは載せない。氏名順
function printRoster(){
  var e = curEvent($("a_ev").value); if (!e) return;
  var rows = (e.applicants || []).filter(function(a){ return a.taio !== "キャンセル"; }).slice().sort(function(a, b){ return String(a.name).localeCompare(String(b.name), "ja"); });
  var people = rows.reduce(function(n, a){ return n + 1 + (Number(a.dohanCount) || 0); }, 0);
  var html = "<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>受付名簿 " + escHtml(e.name) + "</title>"
    + "<style>body{font-family:sans-serif;margin:14mm 12mm;color:#222}h1{font-size:18px;margin:0 0 4px}.m{color:#555;font-size:13px;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eee}td.c{width:34px;text-align:center;font-size:16px}@media print{button{display:none}}</style></head><body>"
    + "<button onclick='window.print()' style='float:right'>印刷</button>" + logoImg() + "<h1>受付名簿　" + escHtml(e.name) + "</h1>"
    + "<div class='m'>" + escHtml((e.date || "") + " " + (e.time || "")) + (e.place ? "　" + escHtml(e.place) : "") + "　申込 " + rows.length + "件・" + people + "人</div>"
    + "<table><tr><th>受付</th><th>氏名</th><th>区分</th><th>同伴</th><th>連絡先</th><th>メモ</th></tr>"
    + rows.map(function(a){ return "<tr><td class='c'>☐</td><td>" + escHtml(a.name) + (a.member ? "（会員）" : "") + "</td><td>" + escHtml(a.kubun || "") + "</td><td>" + (a.dohanCount ? escHtml(a.dohanCount + "名" + (a.dohan ? " " + a.dohan : "")) : "") + "</td><td>" + escHtml(a.contact || "") + "</td><td>" + escHtml((a.manual ? "代理申込 " : "") + (a.memo || "")) + "</td></tr>"; }).join("")
    + "</table><div class='m' style='margin-top:10px'>印刷 " + new Date().toLocaleString("ja-JP") + "　個人情報のため、使用後は回収して処分してください</div></body></html>";
  openPrintWindow(html);
}
// 申込QR: そのイベントの申込画面に直接飛ぶ LIFF URL（卓上POP・受付での飛び込み用）
// QR（中央に文字マーク。誤り訂正を H にして中央の欠けを補う。マークが読めなければ素のQRのまま）
function brandQr(parent, text, size){
  var holder = el("div", ""); holder.style.display = "inline-block"; parent.appendChild(holder);
  new QRCode(holder, { text: text, width: size, height: size, correctLevel: QRCode.CorrectLevel.H });
  var qc = holder.querySelector("canvas");
  if (!qc) return holder; // canvas が使えない環境は素のQR（表描画）のまま
  var out = document.createElement("img"); out.width = size; out.height = size; out.alt = "QR";
  try { out.src = qc.toDataURL("image/png"); } catch (e) { return holder; }
  // qrcodejs 自身の img/canvas は外す（あとから非同期に src を差し替えに来ても、こちらの画像には影響しない）
  Array.prototype.slice.call(holder.querySelectorAll("img, canvas")).forEach(function(n){ holder.removeChild(n); });
  holder.appendChild(out);
  var em = new Image();
  em.onload = function(){
    try {
      var c = document.createElement("canvas"); c.width = size; c.height = size; var g = c.getContext("2d");
      g.drawImage(qc, 0, 0, size, size);
      var box = Math.round(size * 0.26), eh = Math.round(size * 0.2), ew = Math.round(eh * em.width / em.height), cx = Math.round((size - box) / 2);
      g.fillStyle = "#fff"; g.fillRect(cx, cx, box, box);
      g.drawImage(em, Math.round((size - ew) / 2), Math.round((size - eh) / 2), ew, eh);
      out.src = c.toDataURL("image/png");
    } catch (e) { /* 失敗しても素のQRのまま */ }
  };
  em.src = "assets/icon.png";
  return holder;
}
function showEventQr(){
  var n = $("a_ev").value; if (!n) return;
  var box = $("ev_qr"); box.style.display = "block"; box.innerHTML = "";
  var url = "https://liff.line.me/" + LIFF_ID + "?ev=" + encodeURIComponent(n);
  var draw = function(){
    var holder = brandQr(box, url, 220);
    box.appendChild(el("div", "hint", "「" + n + "」の申込画面に直接飛ぶQR。読み取った人は友だち追加のあと申込画面が開きます。長押し・右クリックで画像を保存"));
    var pb = el("button", "b_sub", "このQRを印刷（A4・1枚）");
    pb.onclick = function(){
      var img = holder.querySelector("img") || holder.querySelector("canvas");
      var src = img ? (img.src || (img.toDataURL && img.toDataURL())) : "";
      if (!src) return;
      var w = openPrintWindow("<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>" + escHtml(n) + "</title></head><body style='text-align:center;font-family:sans-serif;padding:40px'>"
        + "<div style='margin-bottom:14px'><img src='" + new URL("assets/logo.svg", location.href).href + "' style='height:40px'></div><h1 style='font-size:28px;margin:0 0 8px'>" + escHtml(n) + "</h1><p style='font-size:18px;margin:0 0 24px'>LINEで読み取って参加申込</p><img src='" + src + "' style='width:80mm;height:80mm'>"
        + "<p style='color:#555;margin-top:24px'>静岡県看護連盟 青年部</p></body></html>");
      if (w) setTimeout(function(){ try { w.print(); } catch (e) {} }, 400);
    };
    box.appendChild(pb);
  };
  if (window.QRCode) return draw();
  var s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; s.integrity = "sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU"; s.crossOrigin = "anonymous";
  s.onload = draw; s.onerror = function(){ box.textContent = "QRの部品を読み込めませんでした。通信環境を確認して開き直してください"; };
  document.head.appendChild(s);
}

// ---- 紹介（自分専用QR・紹介文の転送）----
var GO_URL = location.origin + location.pathname.replace(/[^\/]*$/, "") + "go";
function myName(){ return (STATE && (STATE.memberName || (STATE.me && STATE.me.name) || (STATE.user && STATE.user.name))) || ""; }
// 「ご紹介者」の入力候補（会員名。自由入力もできる）
function fillDatalist(names){ var d = $("member_names"); if (!d) return; d.innerHTML = ""; (names || []).forEach(function(n){ var o = document.createElement("option"); o.value = n; d.appendChild(o); }); }
function myRefUrl(){ return GO_URL + "?src=" + encodeURIComponent("紹介_" + (myName() || "不明").slice(0, 20)); }
function showMyQr(id){
  var pv = $("ref_preview"); if (pv) pv.textContent = referralBody() + "\n" + myRefUrl();
  var box = $(id); box.style.display = "block"; box.innerHTML = "";
  if (!((window.SITE_CONFIG || {}).ADD_URL || "")){ // go.html の飛び先が未設定だと QR が使えない
    box.appendChild(el("div", "mic-err", "友だち追加 URL の設定待ちです（担当）。設定が済むと、ここに紹介用の QR が出ます"));
    return;
  }
  var draw = function(){
    brandQr(box, myRefUrl(), 220);
    box.appendChild(el("div", "hint", "静岡県看護連盟 公式LINE 友だち追加（紹介: " + (myName() || "不明") + "）。画面を見せて読み取ってもらってください"));
  };
  if (window.QRCode) return draw();
  var s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; s.integrity = "sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU"; s.crossOrigin = "anonymous";
  s.onload = draw; s.onerror = function(){ box.textContent = "QRの部品を読み込めませんでした。通信環境を確認して開き直してください"; };
  document.head.appendChild(s);
}
function referralBody(){
  var t = (STATE && STATE.referralText) || "";
  if (!t || t.indexOf("🏅") === 0) t = "静岡県看護連盟の公式LINEを紹介します。\n現場で困っていることを送ると、連盟がまとめて議員に届けます。研修や意見交換会の案内、処遇や制度の動きも短く届きます。\n登録は無料で、会員でなくても使えます。下のリンクから友だち追加できます。";
  return t;
}
function shareReferral(){
  var text = referralBody() + "\n" + myRefUrl();
  if (liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")){
    liff.shareTargetPicker([{ type: "text", text: text }])
      .then(function(res){ if (res) say("紹介文を送りました"); })
      .catch(function(){ copyText(text); });
  } else { copyText(text); }
}
// 紹介文をその場でコピーする（LINE の外や、共有が使えない端末向け）
function copyReferral(){
  copyText(referralBody() + "\n" + myRefUrl());
}

function copyText(text){
  var done = function(){ alert("紹介文をコピーしました。送りたいトークに貼り付けてください"); };
  var fallback = function(){ prompt("この文をコピーして送ってください", text); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

// ---- 画面の切替（メニューの各ボタンは別々の画面として開く。タブで行き来できる） ----
var VIEW_CUR = "";
var INTRO_CHECKED = false;
var KEEP_SCROLL = false;
function showView(v){
  var changed = VIEW_CUR !== v;
  VIEW_CUR = v;
  var secs = document.querySelectorAll("#admin_ui section.vw");
  for (var i = 0; i < secs.length; i++) secs[i].classList.toggle("on", secs[i].getAttribute("data-v") === v);
  var tabs = document.querySelectorAll("#tabs .tab");
  for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle("on", tabs[j].getAttribute("data-v") === v);
  if (changed && !KEEP_SCROLL) window.scrollTo({ top: 0 });
  KEEP_SCROLL = false;
}

// ---- 使い方ページ（初回だけ自動で開く。以後は左の「使い方」） ----
function showIntro(force){
  // 初めて開いたときだけ「使い方」を表示する（URL で画面が指定されているときは除く）。以後は左の「使い方」から
  try { if (!force && localStorage.getItem("kango_intro_done")) return; } catch (e) {}
  try { localStorage.setItem("kango_intro_done", "1"); } catch (e) {}
  if (force || !VIEW) showView("help");
}

// ---- 要対応（今日やること・最小カード） ----
// 担当に選べる人: 会員名簿から（管理者を先に）。いまの担当が名簿に無ければ先頭に足す
function assigneeNames(current){
  var ms = (STATE && STATE.members) || [];
  var names = ms.filter(function(m){ return m.role === "管理者" && m.name; }).map(function(m){ return m.name; })
    .concat(ms.filter(function(m){ return m.role !== "管理者" && m.name; }).map(function(m){ return m.name; }));
  if (!names.length) names = ((STATE && STATE.admins) || []).map(function(a){ return a.name; });
  if (current && names.indexOf(current) < 0) names.unshift(current);
  return names;
}
// 担当ごとの進行中の件数（加入・対象外以外）。割り当てのときに負荷を見るため
function assigneeCounts(){
  var m = {}; ((STATE && STATE.all) || []).forEach(function(c){ if (c.tanto && !/^(5 |対象外)/.test(String(c.status || ""))) m[c.tanto] = (m[c.tanto] || 0) + 1; });
  return m;
}
function assigneeSelect(c, cls){
  var sel = document.createElement("select"); sel.className = cls || ""; sel.title = "担当を割り当てる（括弧は進行中の件数）";
  var o0 = document.createElement("option"); o0.value = ""; o0.textContent = "担当なし"; sel.appendChild(o0);
  var cnt = assigneeCounts();
  assigneeNames(c.tanto).forEach(function(n){ var o = document.createElement("option"); o.value = n; o.textContent = n + (cnt[n] ? "（" + cnt[n] + "）" : ""); sel.appendChild(o); });
  sel.value = c.tanto || "";
  sel.onclick = function(ev){ ev.stopPropagation(); };
  sel.onchange = function(ev){ ev.stopPropagation(); var v = sel.value; if (v === (c.tanto || "")) return; caseOp(c.id, "tanto", v); };
  return sel;
}
function todoCard(c){
  var card = el("div", "card");
  var due = c.overdue === null || c.overdue === undefined ? "" : (c.overdue > 0 ? "（" + c.overdue + "日超過）" : c.overdue === 0 ? "（今日）" : "（期限 " + c.due + "）");
  var head = el("div", "", c.name + (c.kubun ? "（" + c.kubun + "）" : "")); head.style.fontWeight = "bold"; card.appendChild(head);
  card.appendChild(el("small", "", "次: " + c.next + due + " ／ 担当: " + (c.tanto || "なし") + (c.hasLine ? "" : " ／ LINE未紐付")));
  if (c.handoff) card.appendChild(el("small", "", "🎉 加入後の手順 " + c.handoff.step + "/" + c.handoff.total));
  var row = el("div", "apl");
  var add = function(label, cls, fn){ var b = el("button", cls, label); b.onclick = fn; row.appendChild(b); };
  var asg = assigneeSelect(c, "asg"); row.appendChild(asg);
  if (c.tanto !== myName()) add("私が対応します", "b_att", function(){ caseOp(c.id, "assign", ""); });
  add("対応済み", "b_clr", function(){ if (confirm("「" + c.next + "」を済みにしますか？")) caseOp(c.id, "done", ""); });
  add("3日後に", "b_clr", function(){ var d = new Date(Date.now() + 3 * 86400000); caseOp(c.id, "update", JSON.stringify({ due: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") })); });
  add("詳細", "", function(){ openDetail(c.id); });
  card.appendChild(row);
  return card;
}
function renderCases(st){
  var box = $("a_cases"), fbox = $("a_cases_future"); if (!box) return; box.innerHTML = ""; fbox.innerHTML = "";
  var all = st.cases || [], me = myName();
  var isDue = function(c){ return c.overdue === null || c.overdue === undefined || c.overdue >= 0; };
  var mine = all.filter(function(c){ return !c.tanto || (me && c.tanto === me); });
  var scope = (!me || TODO_SCOPE === "all") ? "all" : "mine";
  var list = scope === "all" ? all : mine;
  // 切替チップ（管理者が増えても自分の分だけ見られる。既定は自分の担当＋担当なし）
  var sc = $("todo_scope");
  if (sc){ sc.innerHTML = "";
    if (me) [["mine", "自分の担当＋担当なし", mine.filter(isDue).length], ["all", "全員分", all.filter(isDue).length]].forEach(function(o){
      var b = el("span", "chip btn" + (scope === o[0] ? " sel" : ""), o[1] + "（" + o[2] + "）");
      b.onclick = function(){ TODO_SCOPE = o[0]; try { localStorage.setItem("kango_todo_scope", TODO_SCOPE); } catch (e) {} renderCases(STATE); };
      sc.appendChild(b);
    });
  }
  var now = list.filter(isDue);
  var later = list.filter(function(c){ return !isDue(c); });
  var nowAll = all.filter(isDue).length;
  $("todo_count").textContent = nowAll ? "（" + nowAll + "件）" : "";
  var nav = $("nav_todo"); if (nav) nav.textContent = nowAll ? "（" + nowAll + "）" : "";
  if (!now.length){
    var emp = el("div", "panel");
    emp.appendChild(el("div", "", scope === "mine" && nowAll ? "自分の担当で今日やることはありません（全員分では " + nowAll + " 件）" : "今日やることはありません"));
    var un = (st.all || []).filter(function(c){ return !c.tanto && !/^(5 |対象外)/.test(String(c.status || "")); }).length;
    if (un){ var b1 = el("button", "b_sub", "担当なしの友だち " + un + " 人を見る"); b1.onclick = function(){ showView("cases"); var t = $("a_tanto"); if (t){ t.value = "__none__"; } renderAll(); }; emp.appendChild(b1); }
    box.appendChild(emp);
  }
  [["期限超過", now.filter(function(c){ return c.overdue > 0; })], ["今日", now.filter(function(c){ return c.overdue === 0; })], ["期限なし", now.filter(function(c){ return c.overdue === null || c.overdue === undefined; })]]
    .forEach(function(g){ if (!g[1].length) return; box.appendChild(el("div", "todo-h", g[0] + "（" + g[1].length + "）")); g[1].forEach(function(c){ box.appendChild(todoCard(c)); }); });
  $("todo_future").style.display = later.length ? "block" : "none";
  $("todo_future_sum").textContent = "予定 " + later.length + "件（期限が先）";
  later.forEach(function(c){ fbox.appendChild(todoCard(c)); });
}

// ---- 友だち一覧（名簿・1行） ----
var LAST_ROSTER = [];
// 青年部用の一覧を印刷（いまの絞り込みのまま。連絡先は載せない）
function printCases(){
  var list = LAST_ROSTER || [];
  if (!list.length){ alert("表示中の友だちがいません"); return; }
  var sorted = list.slice().sort(function(a, b){ return String(a.status).localeCompare(String(b.status), "ja") || String(a.name).localeCompare(String(b.name), "ja"); });
  var html = "<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>友だち一覧</title>"
    + "<style>body{font-family:sans-serif;margin:12mm;color:#222}h1{font-size:18px;margin:0 0 4px}.m{color:#555;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}@media print{button{display:none}}</style></head><body>"
    + "<button onclick='window.print()' style='float:right'>印刷</button>" + logoImg() + "<h1>友だち一覧（青年部用）</h1><div class='m'>" + sorted.length + "人　" + new Date().toLocaleString("ja-JP") + "　個人情報のため、使用後は回収して処分してください</div>"
    + "<table><tr><th>番号</th><th>氏名（区分）</th><th>段階</th><th>担当</th><th>次にやること</th><th>期限</th><th>更新</th><th>メモ（末尾）</th></tr>"
    + sorted.map(function(c){ return "<tr><td>" + escHtml(c.id) + "</td><td>" + escHtml(c.name + (c.kubun ? "（" + c.kubun + "）" : "")) + "</td><td>" + escHtml(c.status) + "</td><td>" + escHtml(c.tanto || "") + "</td><td>" + escHtml(c.next || "") + "</td><td>" + escHtml(c.due || "") + (c.overdue > 0 ? "（" + c.overdue + "日超過）" : "") + "</td><td>" + escHtml(c.updated || "") + "</td><td>" + escHtml(String(c.memoFull || c.memo || "").slice(-60)) + "</td></tr>"; }).join("")
    + "</table></body></html>";
  openPrintWindow(html);
}
function renderAll(){
  var box = $("a_all"); if (!box || !STATE) return; box.innerHTML = "";
  var sel = $("a_stage");
  if (sel.options.length <= 1) (STATE.statusList || []).forEach(function(v){ var o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
  var ts = $("a_tanto"), names = {};
  (STATE.all || []).forEach(function(c){ if (c.tanto) names[c.tanto] = 1; });
  var want = ["", "__me__", "__none__"].concat(Object.keys(names).sort());
  if (ts.getAttribute("data-n") !== String(want.length)){
    var cur = ts.value; ts.innerHTML = "";
    want.forEach(function(v){ var o = document.createElement("option"); o.value = v; o.textContent = v === "" ? "担当：すべて" : v === "__me__" ? "自分の担当" : v === "__none__" ? "担当なし" : v; ts.appendChild(o); });
    ts.value = cur; ts.setAttribute("data-n", String(want.length));
  }
  var q = ($("a_q").value || "").trim().toLowerCase(), stage = sel.value, tanto = ts.value, me = myName();
  var list = (STATE.all || []).filter(function(c){
    if (stage && c.status !== stage) return false;
    if (tanto === "__none__" && c.tanto) return false;
    if (tanto === "__me__" && c.tanto !== me) return false;
    if (tanto && tanto.charAt(0) !== "_" && c.tanto !== tanto) return false;
    if (!q) return true;
    return [c.name, c.tanto, c.kubun, c.shokuba, c.kikkake, c.shokai].join(" ").toLowerCase().indexOf(q) >= 0;
  });
  var ch = $("stage_chips");
  if (ch){ ch.innerHTML = "";
    var cnt = {}; (STATE.all || []).forEach(function(c){ cnt[c.status] = (cnt[c.status] || 0) + 1; });
    var mkChip = function(v, label, n){ var b = el("span", "chip btn" + (stage === v ? " sel" : ""), label + " " + n); b.onclick = function(){ sel.value = v; renderAll(); }; ch.appendChild(b); };
    mkChip("", "全", (STATE.all || []).length);
    (STATE.statusList || []).forEach(function(v){ if (cnt[v]) mkChip(v, v, cnt[v]); });
  }
  LAST_ROSTER = list;
  if (!list.length){ box.appendChild(el("div", "hint", q ? "該当なし（未登録なら「＋ 追加」）" : "まだ友だちがいません")); return; }
  if (window.innerWidth >= 900){ box.appendChild(rosterTable(list)); return; }
  list.slice(0, 200).forEach(function(c){
    var row = el("div", "apl"); row.style.cursor = "pointer"; row.onclick = function(){ openDetail(c.id); };
    var nm = el("div", "nm", c.name + (c.kubun ? "（" + c.kubun + "）" : ""));
    nm.appendChild(el("small", "", c.status + " ／ 担当 " + (c.tanto || "なし") + (c.next ? " ／ 次: " + c.next : "") + (c.updated ? " ／ 更新 " + c.updated : "")));
    row.appendChild(nm);
    row.appendChild(el("span", "", "›"));
    box.appendChild(row);
  });
  if (list.length > 200) box.appendChild(el("div", "hint", "200件まで表示。検索で絞ってください"));
}

// 日付の相対表示（今日・昨日・N日前。60日を超えたら日付のまま）
function relDate(ts, fallback){
  var t = Number(ts) || 0; if (!t) return fallback || "";
  var d = new Date(t), n = new Date(); // 暦日で比べる（昨日の夕方の更新は「昨日」）
  var days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return "今日"; if (days === 1) return "昨日"; if (days <= 60) return days + "日前";
  return fallback || "";
}

// 広い画面向けの表（見出しを押すと並べ替え）
var ROSTER_SORT = { key: "updatedTs", dir: -1 };
function rosterTable(list){
  var cols = [["name", "名前"], ["kubun", "区分"], ["status", "段階"], ["tanto", "担当"], ["next", "次にやること"], ["due", "期限"], ["updated", "更新"]];
  var k = ROSTER_SORT.key, d = ROSTER_SORT.dir;
  var sorted = list.slice().sort(function(a, b){ var x = a[k] == null ? "" : a[k], y = b[k] == null ? "" : b[k]; if (x < y) return -d; if (x > y) return d; return 0; });
  var t = document.createElement("table"); t.className = "roster";
  var thead = document.createElement("thead"), tr = document.createElement("tr");
  cols.forEach(function(c){
    var th = document.createElement("th"); th.textContent = c[1] + (ROSTER_SORT.key === (c[0] === "updated" ? "updatedTs" : c[0]) ? (d > 0 ? " ▲" : " ▼") : "");
    th.onclick = function(){ var key = c[0] === "updated" ? "updatedTs" : c[0]; ROSTER_SORT = { key: key, dir: ROSTER_SORT.key === key ? -ROSTER_SORT.dir : (key === "updatedTs" ? -1 : 1) }; renderAll(); };
    tr.appendChild(th);
  });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = document.createElement("tbody");
  sorted.slice(0, 500).forEach(function(c){
    var r = document.createElement("tr"); r.className = "row"; r.onclick = function(){ openDetail(c.id); };
    var due = c.overdue === null || c.overdue === undefined ? "" : (c.overdue > 0 ? c.due + "（" + c.overdue + "日超過）" : c.overdue === 0 ? "今日" : c.due);
    [c.name, c.kubun || "", c.status, c.tanto || "", c.next || "", due, relDate(c.updatedTs, c.updated)].forEach(function(v, i){
      var td = document.createElement("td");
      if (i === 3){ td.appendChild(assigneeSelect(c, "asg")); r.appendChild(td); return; }
      td.textContent = v;
      if (i === 5 && c.overdue > 0) td.style.color = "#C0392B"; else if (i === 5 && c.overdue === 0) td.style.color = "#E65100";
      if (i === 6 && c.stale > 30) td.style.color = "#999";
      r.appendChild(td);
    });
    tb.appendChild(r);
  });
  t.appendChild(tb);
  return t;
}

// ---- 友だちの詳細（1人について見る・更新する） ----
var DETAIL_ID = null;
function caseById(id){ return (STATE && STATE.all || []).filter(function(c){ return String(c.id) === String(id); })[0]; }
function openDetail(id){
  DETAIL_ID = id || "";
  var isNew = !id;
  $("cd_update").style.display = isNew ? "none" : "block";
  $("cd_other").style.display = isNew ? "none" : "block";
  $("cd_new").style.display = isNew ? "block" : "none";
  $("cd_info").innerHTML = "";
  if (isNew){
    $("cd_title").textContent = "友だちを追加";
    fillSelect("n_kubun", STATE.kubunList || [], ""); fillSelect("n_shokuba", STATE.shokubaList || [], ""); fillSelect("n_kikkake", STATE.keiroList || [], "");
  } else {
    fillDetail(id);
  }
  $("case_detail").style.display = "block";
  window.scrollTo({ top: 0 });
}
function closeDetail(){ DETAIL_ID = null; $("case_detail").style.display = "none"; }
function fillDetail(id){
  var c = caseById(id); if (!c){ closeDetail(); return; }
  $("cd_title").textContent = c.name + (c.kubun ? "（" + c.kubun + "）" : "") + "　" + c.id;
  var info = $("cd_info"); info.innerHTML = "";
  var line = function(t){ info.appendChild(el("div", "", t)); };
  line("段階: " + c.status + " ／ 担当: " + (c.tanto || "なし") + (c.hasLine ? " ／ LINE紐付あり" : " ／ LINE未紐付"));
  var attrs = [c.kubun, c.shokuba, c.yakushoku, c.area, c.kanshin].filter(String).join("・"); if (attrs) line("属性: " + attrs);
  if (c.contact){
    var cdv = el("div", "", "連絡先: "), ct = String(c.contact).trim();
    if (/^[\d\-+\s()（）]{8,}$/.test(ct)){ var ta = el("a", "", ct); ta.href = "tel:" + ct.replace(/[^\d+]/g, ""); cdv.appendChild(ta); }
    else if (/@/.test(ct)){ var ma = el("a", "", ct); ma.href = "mailto:" + ct; cdv.appendChild(ma); }
    else cdv.appendChild(document.createTextNode(ct));
    var cp = el("button", "b_sub", "コピー"); cp.style.marginLeft = "8px"; cp.style.padding = "2px 8px"; cp.style.minHeight = "0"; cp.onclick = function(){ copyText(ct); }; cdv.appendChild(cp);
    info.appendChild(cdv);
  }
  if (c.kikkake || c.shokai) line("きっかけ: " + (c.kikkake || "-") + (c.shokai ? " ／ 紹介: " + c.shokai : ""));
  var hist = []; if (c.created) hist.push("登録 " + c.created); if (c.updated) hist.push("更新 " + c.updated + (c.stale > 30 ? "（" + c.stale + "日前）" : "")); if (c.events && c.events.length) hist.push("イベント: " + c.events.join("、"));
  if (hist.length) line(hist.join(" ／ "));
  if (c.handoff) line("🎉 加入後の手順 " + c.handoff.step + "/" + c.handoff.total + "（「対応済み」で次へ）");
  if (c.partAfter !== null && c.partAfter !== undefined) line("加入後のイベント参加 " + c.partAfter + "回");
  if (c.memoFull || c.memo){
    var parts = String(c.memoFull || c.memo).split(/／|\n/).map(function(x){ return x.trim(); }).filter(String);
    var mb = el("div", ""); mb.appendChild(el("div", "", "メモ（新しい順）:"));
    parts.reverse().forEach(function(x){ var li = el("div", "", "・" + x); li.style.cssText = "padding-left:8px;white-space:pre-wrap"; mb.appendChild(li); });
    info.appendChild(mb);
  }
  // 更新フォーム
  var ss = $("cd_status"); ss.innerHTML = ""; (STATE.statusList || []).forEach(function(v){ var o = document.createElement("option"); o.value = v; o.textContent = v; ss.appendChild(o); }); ss.value = c.status;
  var ts = $("cd_tanto"); ts.innerHTML = "<option value=''>（担当なし）</option>"; var names = assigneeNames(c.tanto), cnt_ = assigneeCounts(); if (false) names.unshift(c.tanto); names.forEach(function(n){ var o = document.createElement("option"); o.value = n; o.textContent = n + (cnt_[n] ? "（" + cnt_[n] + "）" : ""); ts.appendChild(o); }); ts.value = c.tanto || "";
  $("cd_next").value = c.next || ""; $("cd_due").value = c.dueYmd || ""; $("cd_memo").value = "";
  // その他
  $("cd_name").value = c.name;
  fillSelect("at_kubun", STATE.kubunList || [], ""); $("at_kubun").value = c.kubun || "";
  fillSelect("at_shokuba", STATE.shokubaList || [], ""); $("at_shokuba").value = c.shokuba || "";
  fillSelect("at_kanshin", STATE.kanshinList || [], ""); $("at_kanshin").value = c.kanshin || "";
  $("at_yakushoku").value = c.yakushoku || ""; $("at_area").value = c.area || "";
  var acts = $("cd_actions"); acts.innerHTML = "";
  var add = function(label, cls, fn){ var b = el("button", cls, label); b.onclick = fn; acts.appendChild(b); };
  if (c.hasLine && !/^5 /.test(c.status)) add("会員にする", "b_att", function(){ if (confirm(c.name + " を会員にしますか？（段階は「5 加入」、メニューが会員用に切り替わります）")) caseOp(c.id, "to_member", ""); });
  if (!/^(5 |対象外)/.test(c.status)) add("相談を記録", "b_att", function(){ recordMeeting(c); });
  if (!c.hasLine) add("紹介文をLINEで送る", "", function(){ shareReferral(); });
  add("統合", "", function(){ var t = prompt("残す側の番号（例 C-003）。この人（" + c.id + "）は「対象外」になり、空欄の情報は残す側に寄せます"); if (!t) return; if (confirm(c.id + " を " + t.trim() + " に統合しますか？")) caseOp(c.id, "merge", t.trim()); });
  add("削除", "b_abs", function(){
    var ev = (c.events && c.events.length) || 0;
    var warn = c.name + " を友だち一覧から削除します。" + (ev ? "この人の申込 " + ev + " 件の記録も消えます（イベントの人数・出欠から外れます）。" : "") + "元に戻せません。";
    if (!/^1 /.test(c.status) || ev) warn += "\n実際に対象外した人は「対象外」にして記録を残すのが基本です。";
    if (confirm(warn) && confirm("本当に削除しますか？")) caseOp(c.id, "delete", "force");
  });
}
// 相談を記録: 所感をメモに残し、段階を「4 関心あり」に、次にやることと期限（7日後）を1回で
function recordMeeting(c){
  var note = prompt("相談の所感（メモに残ります。相手の関心・懸念・約束したことなど）", "");
  if (note === null) return;
  var nextTxt = prompt("次にやること（期限は7日後に入ります。あとで直せます）", "例会見学の日程調整");
  if (nextTxt === null) return;
  var d = new Date(Date.now() + 7 * 86400000);
  var due = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  say("記録中…");
  var memoP = note.trim() ? api("liff_admin_case", { id: c.id, op: "memo", value: "相談: " + note.trim() }) : Promise.resolve(null);
  memoP.then(function(){ return api("liff_admin_case", { id: c.id, op: "update", value: JSON.stringify({ status: /^[45] /.test(c.status) ? undefined : "4 関心あり", next: nextTxt.trim(), due: due }) }); })
    .then(function(st){ renderAdmin(st); say("相談を記録しました（段階4・次にやること・期限7日後）"); })
    .catch(function(e){ say("エラー: " + e.message); });
}
function saveDetail(){
  var c = caseById(DETAIL_ID); if (!c) return;
  var up = {};
  if ($("cd_status").value !== c.status) up.status = $("cd_status").value;
  if ($("cd_tanto").value !== (c.tanto || "")) up.tanto = $("cd_tanto").value;
  var nx = $("cd_next").value.trim(), due = $("cd_due").value;
  if (nx !== (c.next || "") || due !== (c.dueYmd || "")) { up.next = nx; up.due = due; }
  if (!Object.keys(up).length){ say("変更はありません"); return; }
  if (up.status && /^対象外/.test(up.status) && !confirm(c.name + " を「対象外」にしますか？（追撃はしません）")) return;
  caseOp(c.id, "update", JSON.stringify(up));
}
function detailOp(op){
  var c = caseById(DETAIL_ID); if (!c) return;
  if (op === "done" && !confirm("次にやることを済みにしますか？")) return;
  caseOp(c.id, op, "");
}
function addMemoDetail(){
  var c = caseById(DETAIL_ID); if (!c) return;
  var t = $("cd_memo").value.trim(); if (!t){ alert("メモを入力してください"); return; }
  caseOp(c.id, "memo", t);
}
function saveOther(){
  var c = caseById(DETAIL_ID); if (!c) return;
  var n = $("cd_name").value.trim();
  var at = { kubun: $("at_kubun").value, yakushoku: $("at_yakushoku").value.trim(), shokuba: $("at_shokuba").value, area: $("at_area").value.trim(), kanshin: $("at_kanshin").value };
  var doAttrs = function(){ caseOp(c.id, "attrs", JSON.stringify(at)); };
  if (n !== c.name) {
    say("更新中…");
    api("liff_admin_case", { id: c.id, op: "rename", value: JSON.stringify({ name: n }) }).then(function(st){ renderAdmin(st); doAttrs(); }).catch(function(e){ say("エラー: " + e.message); });
  } else doAttrs();
}
function adminAddCase(force){
  var d = { name: $("n_name").value.trim(), kubun: $("n_kubun").value, shokuba: $("n_shokuba").value, kikkake: $("n_kikkake").value,
            shokai: $("n_shokai").value.trim(), memo: $("n_memo").value.trim(), next: $("n_next").value.trim(), selfTanto: $("n_self").checked, force: !!force };
  if (!d.name){ alert("氏名を入力してください"); return; }
  say("追加中…");
  api("liff_admin_add_case", { data: d }).then(function(st){
    ["n_name","n_shokai","n_memo","n_next"].forEach(function(id){ $(id).value = ""; });
    $("n_kubun").value = ""; $("n_shokuba").value = ""; $("n_kikkake").value = "";
    closeDetail(); renderAdmin(st);
  }).catch(function(e){
    if (!force && /同名の友だちがいます/.test(e.message)){ if (confirm(e.message + "\n\n別人として追加しますか？")) adminAddCase(true); else say(e.message); }
    else say("エラー: " + e.message);
  });
}
function caseOp(id, op, value){
  say("更新中…");
  api("liff_admin_case", { id: id, op: op, value: value }).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}

// イベントの一覧表（行を押すと下の登録欄に読み込む）
function renderEventTable(st){
  var box = $("ev_table"); if (!box) return; box.innerHTML = "";
  var cur = $("a_ev").value; var ee = $("ev_editing"); if (ee) ee.textContent = cur ? "編集中: " + cur : "新規作成";
  var evs = sortedEvents(visibleEvents(st));
  if (!evs.length){ box.appendChild(el("div", "hint", "イベントはまだありません。下の欄で作成できます")); return; }
  var wide = window.innerWidth >= 900;
  var state = function(e){ return (e.past || !e.active) ? "終了" : (e.open ? "受付中" : "受付終了"); };
  var bc = function(e){ return e.broadcastAt ? "済 " + e.broadcastAt : (e.scheduleAt ? "予約 " + e.scheduleAt.replace("T", " ") : "未"); };
  if (wide){
    var t = document.createElement("table"); t.className = "roster";
    var tr = document.createElement("tr");
    ["開催日", "イベント", "状態", "申込／定員", "配信", "到達", "御礼", ""].forEach(function(h){ var th = document.createElement("th"); th.textContent = h; tr.appendChild(th); });
    var th_ = document.createElement("thead"); th_.appendChild(tr); t.appendChild(th_);
    var tb = document.createElement("tbody");
    evs.forEach(function(e){
      var r = document.createElement("tr"); r.className = "row"; r.onclick = function(){ $("a_ev").value = e.name; adminLoad(); };
      [e.date || "", e.name, state(e), e.count + (e.cap ? "／" + e.cap : ""), bc(e), e.reach || "", e.thanksSent || (e.thanksAuto ? "自動" : "しない"), "編集 ›"].forEach(function(v){ var td = document.createElement("td"); td.textContent = v; r.appendChild(td); });
      tb.appendChild(r);
    });
    t.appendChild(tb); box.appendChild(t);
  } else {
    evs.forEach(function(e){
      var row = el("div", "apl"); row.style.cursor = "pointer"; row.onclick = function(){ $("a_ev").value = e.name; adminLoad(); };
      var nm = el("div", "nm", e.name);
      nm.appendChild(el("small", "", (e.date || "") + " ／ " + state(e) + " ／ 申込 " + e.count + (e.cap ? "／" + e.cap : "") + " ／ 配信 " + bc(e) + (e.reach ? " ／ 到達 " + e.reach : "")));
      row.appendChild(nm); row.appendChild(el("span", "", "›"));
      box.appendChild(row);
    });
  }
}

// 開催から3か月より前のイベントは一覧から隠す（チェックで表示）
function visibleEvents(st){
  var showOld = $("a_showold") && $("a_showold").checked;
  var d = new Date(); d.setDate(d.getDate() - 90);
  var cut = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  return (st.events || []).filter(function(e){ return showOld || !e.past || !e.date || e.date >= cut; });
}
// 写しを介さずGASから取り直す（シートを直接直した直後用）
function refreshAdmin(){
  say("最新の情報を取得中…（数秒かかります）");
  api("liff_admin_bootstrap", { refresh: true }).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}

// ---- 会員一覧 ----
function renderMembers(st){
  var box = $("a_members"); if (!box) return; box.innerHTML = "";
  var list = st.members || [];
  box.appendChild(el("div", "hint", "登録済み " + list.length + "人（管理者は管理者登録で自動的に会員扱い）"));
  list.forEach(function(m){
    var row = el("div", "apl");
    var nm = el("div", "nm", (m.name || "（氏名未設定）") + "　" + m.role + (m.since ? "・" + m.since : ""));
    var normN = function(x){ return String(x || "").replace(/（LINE表示名・要確認）/g, "").replace(/[\s　]+/g, ""); };
    var refs = m.name ? (st.all || []).filter(function(c){ return normN(c.shokai) && normN(c.shokai) === normN(m.name); }) : [];
    if (refs.length) nm.appendChild(el("span", "tag att", "紹介 " + refs.length + "人（加入 " + refs.filter(function(c){ return /^5 /.test(c.status); }).length + "）"));
    row.appendChild(nm);
    var b1 = el("button", "", "氏名を修正"); b1.onclick = function(){ var n = prompt("氏名（友だちの「ご紹介者」欄と照合します）", m.name || ""); if (n !== null && n.trim()) memberOp("rename", m.uid, n.trim()); }; row.appendChild(b1);
    if (m.role !== "管理者"){ var b2 = el("button", "b_abs", "外す"); b2.onclick = function(){ if (confirm((m.name || "この会員") + " を会員から外しますか？（通常メニューに戻ります）")) memberOp("remove", m.uid, ""); }; row.appendChild(b2); }
    box.appendChild(row);
  });
}
// ---- 管理: 現場の声（要確認の判断・件数・未処理・鮮度）----
function renderVoicesAdmin(st){
  var v = st.voices;
  var bx = $("v_buckets"), tb = $("v_todo"), th = $("v_themes_admin");
  if (!bx || !tb || !th) return;
  if (!v){ bx.innerHTML = ""; tb.innerHTML = ""; th.innerHTML = ""; return; }
  $("v_sheet").href = st.sheetUrl || "#";
  renderVoiceAi(v);
  renderVoiceCheck(v);
  renderVoicePublished(v);
  bx.innerHTML = "";
  (v.buckets || []).forEach(function(b){ bx.appendChild(el("span", "chip" + (b.n ? " ok" : " ng"), b.label + " " + b.n)); });
  var todoN = ((v.buckets || []).filter(function(b){ return b.key === "todo"; })[0] || {}).n || 0;
  var nav = $("nav_voices"); if (nav) nav.textContent = todoN ? "（" + todoN + "）" : "";

  tb.innerHTML = "";
  var todo = v.todo || [];
  if (!todo.length){ tb.appendChild(el("div", "hint", "未処理はありません")); }
  todo.forEach(function(t){
    var row = el("div", "hist");
    row.appendChild(el("div", "t", t.no + "　" + (t.at || "") + "　" + (t.themes || "（テーマなし）")));
    row.appendChild(el("div", "m", "本文は「声」シートで読んでください（画面と通知には出しません）"));
    tb.appendChild(row);
  });
  // 意見（公開された要約へのコメント）。要確認を先に出す
  var cms = v.comments || [];
  if (cms.length){
    tb.appendChild(el("div", "t", "💬 意見 " + cms.length + "件（要確認 " + cms.filter(function(c){ return c.state === "要確認"; }).length + "）"));
    cms.forEach(function(c){
      var row = el("div", "hist");
      row.appendChild(el("div", "t", c.no + "　↳ 親 " + c.parent + "　" + (c.at || "") + "　" + c.state
        + (c.likes ? "　♥ " + c.likes : "") + (c.checked ? "" : "　（点検まだ）")));
      row.appendChild(el("div", "m", c.text));
      if (c.why) row.appendChild(el("small", "", c.why));
      var bar = el("div", "");
      if (c.state !== "公開"){ var bp = el("button", "b_sub", "公開する"); bp.onclick = function(){ commentOp("comment_publish", c.no, "意見 " + c.no + " を公開します。よろしいですか？"); }; bar.appendChild(bp); }
      if (c.state !== "非公開"){ var bh = el("button", "b_sub", "非公開にする"); bh.onclick = function(){ commentOp("comment_hide", c.no, "意見 " + c.no + " を非公開にします。よろしいですか？"); }; bar.appendChild(bh); }
      row.appendChild(bar);
      tb.appendChild(row);
    });
  }

  // 相談（話を聞いてほしい）。本文は出さず、受付番号・テーマ・期限だけ
  var talk = v.talk || [];
  if (talk.length){
    tb.appendChild(el("div", "t", "🙋 相談（話を聞いてほしい）" + talk.length + "件"));
    talk.forEach(function(t){
      var row = el("div", "hist");
      row.appendChild(el("div", "t", t.no + "　" + (t.themes || "") + "　受付 " + (t.at || "") + "　期限 " + (t.due || "")
        + (t.overdue > 0 ? "（" + t.overdue + "日超過）" : "")));
      var b = el("button", "b_sub", "連絡済みにする");
      b.onclick = function(){ voiceContacted(t.no); };
      row.appendChild(b);
      tb.appendChild(row);
    });
  }

  th.innerHTML = "";
  var tbl = document.createElement("table"); tbl.className = "kv";
  (v.themes || []).forEach(function(t){
    var tr = document.createElement("tr");
    var a = document.createElement("td"); a.textContent = t.name;
    var b = document.createElement("td");
    b.textContent = t.n + "件" + (t.updated ? "　最終更新 " + t.updated : "　更新なし");
    if (t.stale) b.appendChild(el("span", "tag man", "確認中（" + v.staleDays + "日以上）"));
    tr.appendChild(a); tr.appendChild(b); tbl.appendChild(tr);
  });
  th.appendChild(tbl);
  th.appendChild(el("div", "hint", "件数が " + v.k + " 件未満のところは、公開の盤面では数を伏せています（VOICE_K）"));
}

// 自動処理の方式と、最終自動処理日時
// 📣 お知らせの配信（イベント以外の連絡）。宛先を選んで送る
function countNotice(){ $("nt_count").textContent = ($("nt_text").value || "").length + " / 1000字"; }
function sendNotice(test){
  var text = $("nt_text").value.trim();
  var target = $("nt_target").value || "全員";
  if (!text){ alert("本文を入力してください"); return; }
  if (text.length > 1000){ alert("お知らせは1000字までです"); return; }
  if (!test && !confirm("「" + target + "」に配信します。取り消せません。よろしいですか？")) return;
  var out = $("nt_out"); out.style.display = "block"; out.textContent = test ? "テスト送信中…" : "配信中…";
  $("nt_send").disabled = true;
  api("liff_admin_ops", { op: "notice_send", arg: JSON.stringify({ text: text, imageUrl: $("nt_img").value.trim(), target: target, test: !!test }) })
    .then(function(j){
      out.textContent = j.message || "送りました";
      $("nt_send").disabled = false;
      if (!test){ $("nt_text").value = ""; $("nt_img").value = ""; countNotice(); refreshAdmin(); }
    })
    .catch(function(e){ out.textContent = "エラー: " + e.message; $("nt_send").disabled = false; });
}

// 意見の公開／非公開
function commentOp(op, no, msg){
  if (!confirm(msg)) return;
  say("記録中…");
  api("liff_admin_ops", { op: op, arg: no }).then(function(j){ say(j.message || "変えました"); refreshAdmin(); })
    .catch(function(e){ say("エラー: " + e.message); });
}

// 連盟から（公開）。公開ページの該当要約の下に出る一言
function voiceNotePublic(no, input){
  var t = String(input.value || "").trim();
  say("保存中…");
  api("liff_admin_ops", { op: "voice_note_public", arg: JSON.stringify({ no: no, text: t }) })
    .then(function(j){ say(j.message || "保存しました"); refreshAdmin(); })
    .catch(function(e){ say("エラー: " + e.message); });
}

// 相談（話を聞いてほしい）に連絡した。本文は扱わず、受付番号だけを送る
function voiceContacted(no){
  if (!confirm("相談 " + no + " を「連絡済み」にします。よろしいですか？")) return;
  say("記録中…");
  api("liff_admin_ops", { op: "voice_contacted", arg: no }).then(function(j){
    say(j.message || "連絡済みにしました");
    refreshAdmin();
  }).catch(function(e){ say("エラー: " + e.message); });
}

function renderVoiceAi(v){
  var box = $("v_ai"); if (!box) return;
  var ai = v.ai || {};
  var last = ai.last ? String(ai.last).replace("T", " ").slice(0, 16) : "";
  var t = "自動処理: " + (ai.provider === "rules" ? "rules（GAS の中の規則）" : ai.provider === "agent" ? "agent（担当の PC の Claude Code）" : String(ai.provider || "未設定"))
    + "／自動公開 " + (ai.autoPublish ? "on" : "off")
    + "／最終 " + (last || "未実行");
  box.textContent = t;
  if (ai.provider === "agent") box.appendChild(el("div", "", "次の処理は月曜。急ぐときは担当の PC で「声処理」を実行してください"));
}

// 要確認の一覧（受付番号・テーマ・理由・下書きの要約。要約は直してから公開できる）
function renderVoiceCheck(v){
  var box = $("v_check"); if (!box) return;
  box.innerHTML = "";
  var list = v.needCheck || [];
  if (!list.length){ box.appendChild(el("div", "hint", "要確認はありません")); return; }
  list.forEach(function(c){
    var row = el("div", "hist");
    row.appendChild(el("div", "t", c.no + "　" + (c.at || "") + "　" + (c.themes || "（テーマなし）")));
    if (c.reason) row.appendChild(el("div", "m", c.reason));
    if (c.themeNote) row.appendChild(el("div", "m", "テーマ案: " + c.themeNote));
    if (!c.canPublish) row.appendChild(el("div", "m", "※ 本人が公開に同意していないため、公開はできません"));
    var ta = document.createElement("textarea");
    ta.rows = 4; ta.value = c.summary || ""; ta.maxLength = 300;
    ta.placeholder = "公開する文（本人の言葉のまま。特定につながる語だけ伏せる。直してから公開できます）";
    row.appendChild(ta);
    var btns = el("div", "chips");
    if (c.canPublish){
      var b1 = el("button", "", "この文で公開");
      b1.onclick = function(){ voiceSave(row, "voice_publish", { no: c.no, summary: ta.value }, c.no + " を公開しました"); };
      btns.appendChild(b1);
    }
    var b2 = el("button", "b_abs", "公開しない");
    b2.onclick = function(){ if (confirm("声 " + c.no + " を公開しないことにしますか？（本文は残ります）")) voiceSave(row, "voice_exclude", { no: c.no }, c.no + " を公開しないことにしました"); };
    btns.appendChild(b2);
    row.appendChild(btns);
    box.appendChild(row);
  });
}

// 公開している要約の一覧。ここで「連盟から（公開）」を書く
function renderVoicePublished(v){
  var box = $("v_pub"); if (!box) return;
  box.innerHTML = "";
  var list = v.published || [];
  if (!list.length){ box.appendChild(el("div", "hint", "公開している要約はまだありません")); return; }
  list.forEach(function(c){
    var row = el("div", "hist");
    row.appendChild(el("div", "t", c.no + "　" + (c.at || "") + "　" + (c.themes || "")
      + "　♥ " + c.likes + "　意見 " + c.comments + "件"));
    row.appendChild(el("div", "m", c.summary));
    var inp = document.createElement("input");
    inp.value = c.note || ""; inp.maxLength = 200; inp.placeholder = "連盟から（公開ページに出る一言・200字まで）";
    row.appendChild(inp);
    var b = el("button", "b_sub", "保存");
    b.onclick = function(){ voiceNotePublic(c.no, inp); };
    row.appendChild(b);
    box.appendChild(row);
  });
}

function voiceOut(text, isError){
  var o = $("v_check_out"); if (!o) return;
  o.style.display = "block"; o.style.color = isError ? "#c62828" : "";
  o.textContent = text;
}

// 押した行をその場でたたみ、保存は裏で行う（失敗したら戻す）。全体の読み直しはしない
function voiceSave(row, op, arg, done){
  if (op === "voice_publish" && !String(arg.summary || "").trim()){ voiceOut("要約を入力してください", true); return; }
  var btns = row.querySelectorAll("button");
  var able = function(on){ Array.prototype.forEach.call(btns, function(b){ b.disabled = !on; }); };
  able(false); // 送信中は同じ行のボタンを押せなくする
  row.style.display = "none";
  voiceOut("保存中…");
  // 2引数の then（成功のあとの例外で、たたんだ行を戻してしまわないように）
  api("liff_admin_ops", { op: op, arg: arg })
    .then(function(){ voiceOut(done); voiceCheckLeft(); },
          function(e){ row.style.display = ""; able(true); voiceOut("保存できませんでした: " + e.message, true); });
}

// たたんだ結果、要確認が残っていなければその旨を出す
function voiceCheckLeft(){
  var box = $("v_check"); if (!box) return;
  var left = Array.prototype.filter.call(box.children, function(x){ return x.style.display !== "none"; });
  if (!left.length) box.appendChild(el("div", "hint", "要確認はありません"));
}

// ---- 管理: 📰最新情報（★ピックアップ／○載せる／×載せない を押して決める）----
// 押した瞬間に見た目と手元の状態を書き換え、押した分は最後の押下から NW_WAIT ミリ秒後に1回にまとめて送る
var NW_NOTE_DONE = false;
function renderNewsAdmin(st){
  var box = $("nw_admin"); if (!box) return;
  var v = st.news || { items: [], note: "", lastCollected: "" };
  if (!NW_NOTE_DONE){ NW_NOTE_DONE = true; $("nw_note").value = v.note || ""; }
  var src = (v.sources || []);
  var ng = src.filter(function(x){ return x.fail >= 2; });
  $("nw_last").textContent = (v.lastCollected ? "最終収集 " + String(v.lastCollected).slice(0, 10) : "まだ収集していません")
    + (src.length ? "　出典ごと: " + src.map(function(x){ return x.name + " " + (x.last || "未取得") + (x.fail ? "（" + x.fail + "回連続で失敗）" : ""); }).join("／") : "")
    + (ng.length ? "　⚠️ " + ng.map(function(x){ return x.name; }).join("・") + " が続けて取れていません" : "");
  box.innerHTML = "";
  var group = "";
  (v.items || []).forEach(function(it){
    // 保存済みの値は、写し（最大10分遅れ）が追いつくまで手元の値を上に置く。追いついたら覚えを消す
    if (it.id in NW_DONE){ if (it.pick === NW_DONE[it.id]) delete NW_DONE[it.id]; else it.pick = NW_DONE[it.id]; }
    if (it.group !== group){ group = it.group; box.appendChild(el("div", "nwa-g", group || "その他")); }
    var row = el("div", "nwa" + (it.pick === "★" ? " on" : it.pick === "×" ? " off" : ""));
    row.dataset.id = it.id;
    row.appendChild(el("div", "nwa-t", (it.video ? "▶ " : "") + it.title));
    var meta = el("div", "nwa-m", it.source + "・" + (it.date || ""));
    if (it.url){ var a = el("a", "nwa-open", "開く"); a.href = it.url; a.target = "_blank"; a.rel = "noopener"; meta.appendChild(a); }
    row.appendChild(meta);
    var chips = el("div", "chips");
    [["★", "★ ピックアップ"], ["○", "○ 載せる"], ["×", "× 載せない"]].forEach(function(p){
      var c = el("span", "chip btn" + (it.pick === p[0] ? " sel" : ""), p[1]);
      c.setAttribute("role", "button"); c.tabIndex = 0;
      c.onclick = function(){ setNewsPick(it.id, p[0]); };
      c.onkeydown = function(ev){ if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar"){ ev.preventDefault(); setNewsPick(it.id, p[0]); } };
      chips.appendChild(c);
    });
    chips.appendChild(el("span", "nwa-s"));
    row.appendChild(chips);
    box.appendChild(row);
  });
  if (!(v.items || []).length) box.appendChild(el("div", "hint", "まだ記事がありません。「いま収集する」を押してください（数十秒かかります）"));
}

function newsOut(text){ var o = $("nw_out"); o.style.display = "block"; o.textContent = text; }

// ==== nw:start ★／○／× の保存（tests/run.js がこの範囲だけを取り出して動かす。ここから下は $ と api と STATE しか使わない）====
var NW_QUEUE = {};      // まだ送っていない押下（記事ID -> 値。同じ行を何度押しても最後の値だけ）
var NW_BEFORE = {};     // 押す前の画面の値（サーバーが確認した値が無いときの巻き戻し先）
var NW_CONFIRMED = {};  // サーバーが保存を確かめた値（巻き戻しはこちらを優先する）
var NW_DONE = {};       // 保存済みの値。写しが追いつくまで、描き直しのときに上に置く
var NW_TIMER = null, NW_SENDING = false;
var NW_WAIT = 700;      // 最後に押してからこれだけ待って、まとめて1回送る
var NW_MAX = 50;        // 1回に送る上限（サーバーの NEWS_SET_MAX と合わせる。あふれた分は次のまとまりへ）

function newsItem(id){ return (((STATE || {}).news || {}).items || []).filter(function(x){ return x.id === id; })[0]; }

// 行の右端に出す小さな知らせ（保存中…／保存済み／失敗）
function newsRowNote(id, text, isError, hideMs){
  var box = $("nw_admin"); if (!box) return;
  var row = box.querySelector('[data-id="' + id + '"]'); if (!row) return;
  var s = row.querySelector(".nwa-s"); if (!s) return;
  s.className = "nwa-s" + (isError ? " ng" : "");
  s.textContent = text;
  if (hideMs) setTimeout(function(){ if (s.textContent === text) s.textContent = ""; }, hideMs);
}

// 見た目と手元の状態を書き換える（押したとき・巻き戻すときの両方から呼ぶ）
function applyNewsPick(id, value){
  var it = newsItem(id);
  if (it) it.pick = value;
  var box = $("nw_admin"); if (!box) return;
  var row = box.querySelector('[data-id="' + id + '"]'); if (!row) return;
  row.classList.toggle("on", value === "★");
  row.classList.toggle("off", value === "×");
  Array.prototype.forEach.call(row.querySelectorAll(".chip"), function(c){ c.classList.toggle("sel", c.textContent.indexOf(value) === 0); });
}

function nwTimer(ms){
  if (NW_TIMER) clearTimeout(NW_TIMER);
  NW_TIMER = (ms === null) ? null : setTimeout(flushNewsPicks, ms);
}

function setNewsPick(id, value){
  if (!(id in NW_BEFORE)) NW_BEFORE[id] = (id in NW_CONFIRMED) ? NW_CONFIRMED[id] : ((newsItem(id) || {}).pick || "");
  NW_QUEUE[id] = value;
  applyNewsPick(id, value);
  newsRowNote(id, "保存中…");
  nwTimer(NW_WAIT);
}

// 押した分をまとめて1回で送る。飛んでいる要求は常に1本、1回は NW_MAX 件まで
function flushNewsPicks(){
  nwTimer(null);
  if (NW_SENDING) return; // 送信中に押された分は、終わってから次のまとまりで送る
  var ids = Object.keys(NW_QUEUE).slice(0, NW_MAX);
  if (!ids.length) return;
  var items = [], before = {};
  ids.forEach(function(id){
    items.push({ id: id, value: NW_QUEUE[id] });
    before[id] = NW_BEFORE[id];
    delete NW_QUEUE[id]; delete NW_BEFORE[id];
  });
  NW_SENDING = true;
  api("liff_admin_ops", { op: "news_set", arg: { items: items } }).then(function(j){
    NW_SENDING = false;
    var bad = {};
    ((j && j.failed) || []).forEach(function(f){ bad[f.id] = f.reason || "保存できませんでした"; });
    items.forEach(function(it){
      if (bad[it.id]){ nwRollback(it.id, before[it.id], bad[it.id]); return; }
      NW_CONFIRMED[it.id] = it.value;
      NW_DONE[it.id] = it.value;
      if (!(it.id in NW_QUEUE)) newsRowNote(it.id, "保存済み", false, 1500); // 送信中に押し直された行には出さない
    });
    nwNext();
  }, function(){
    NW_SENDING = false;
    items.forEach(function(it){ nwRollback(it.id, before[it.id], "保存できませんでした。もう一度押してください"); });
    nwNext();
  });
}

// 保存できなかった行を戻す。そのあと押し直された行は、新しい値のままにする
function nwRollback(id, before, reason){
  if (id in NW_QUEUE) return;
  applyNewsPick(id, before);
  if (id in NW_DONE) NW_DONE[id] = before;
  newsRowNote(id, reason, true);
}

// 残り（送信中に押された分・NW_MAX を超えた分）があれば、次のまとまりを送る
function nwNext(){ if (Object.keys(NW_QUEUE).length) nwTimer(0); }
// ==== nw:end ====

function saveNewsNote(){
  var b = $("nw_note_save");
  var label = b ? b.textContent : "";
  if (b){ b.disabled = true; b.textContent = "保存中…"; }
  api("liff_admin_ops", { op: "news_note_set", arg: { text: $("nw_note").value } })
    .then(function(j){ if (b){ b.textContent = "保存しました"; setTimeout(function(){ b.disabled = false; b.textContent = label; }, 1500); } else newsOut(j.message || "保存しました"); },
          function(e){ if (b){ b.disabled = false; b.textContent = label; } newsOut("保存できませんでした: " + e.message); });
}

function newsCollectNow(){
  flushNewsPicks(); // 待っている押下を先に送る（このあと画面を読み直すため）
  newsOut("集めています…（数十秒かかります）");
  api("liff_admin_ops", { op: "news_collect_now" }).then(function(j){
    newsOut((j.message || "") + (j.text ? "\n" + j.text : "") + "\n一覧を読み直しています…");
    refreshAdmin();
  }).catch(function(e){ newsOut("エラー: " + e.message); });
}

function openNewsPage(){
  var id = (window.SITE_CONFIG || {}).LIFF_ID;
  window.open(id ? "https://liff.line.me/" + id + "?v=news" : "news.html", "_blank");
}

function showInvite(){
  if (!confirm("管理者の招待コード（6桁・24時間・何人でも）を発行します。よろしいですか？")) return;
  var out = $("mp_out"); out.style.display = "block"; out.textContent = "発行中…";
  api("liff_admin_ops", { op: "invite" }).then(function(j){ out.textContent = j.text || ""; }).catch(function(e){ out.textContent = "エラー: " + e.message; });
}
function showMemberPass(){
  var out = $("mp_out"); out.style.display = "block"; out.textContent = "取得中…";
  api("liff_admin_ops", { op: "member_pass" }).then(function(j){ out.textContent = j.text || ""; }).catch(function(e){ out.textContent = "エラー: " + e.message; });
}
function memberOp(op, uid, value){
  if (!uid){ alert("登録直後のため、数秒後に「最新に更新」してから操作してください"); return; }
  say("更新中…");
  api("liff_admin_member", { op: op, uid: uid, value: value }).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}

// ---- KPI ----
// 加入率は分母（関心ありになった人）が足りないうちは率を出さない。0%・100% と誤読させない
function hitRateText(k){
  if (!k || k.hitRate === null || k.hitRate === undefined) return "未観測（関心あり " + (k && k.meetingsAll != null ? k.meetingsAll : 0) + "人。" + ((k && k.hitMinN) || 5) + "人から出します）";
  return Math.round(k.hitRate * 100) + "%";
}
function renderKpi(st){
  var ph = $("print_head"); if (ph) ph.textContent = "静岡県看護連盟 公式LINE 状況レポート " + new Date().toLocaleDateString("ja-JP") + (st.kpi && st.kpi.target ? "（今年の加入目標 " + st.kpi.target + "人）" : "");
  var box = $("a_kpi"); if (!box) return; box.innerHTML = "";
  var k = st.kpi; if (!k) return;
  if ($("k_target") && document.activeElement !== $("k_target")) $("k_target").value = k.target || "";
  var bar = function(label, a, b){
    var wrap = el("div", ""); var p = b ? Math.min(100, Math.round(a / b * 100)) : 0;
    wrap.appendChild(el("div", "", label + " " + a + "／" + (b || "-") + (b ? "（" + p + "%）" : "")));
    var track = el("div", ""); track.style.cssText = "height:8px;background:var(--panel);border-radius:4px;overflow:hidden;margin:2px 0 8px";
    var fill = el("div", ""); fill.style.cssText = "height:8px;width:" + p + "%;background:" + (p >= 100 ? "#2E7D32" : "var(--sky)");
    track.appendChild(fill); wrap.appendChild(track); return wrap;
  };
  if (k.target){
    box.appendChild(bar("🎯 " + (k.year || "今年") + "年の加入", k.joined, k.target));
    box.appendChild(bar("🤝 " + (k.year || "今年") + "年の関心あり" + (k.hitProvisional ? "（必要数は仮の目安）" : ""), k.meetings, k.meetNeed));
    box.appendChild(bar("📋 友だち（進行中・必要数は仮の目安）", k.candidates, k.listNeed));
    if (k.provisional) box.appendChild(el("div", "hint", "👥 未加入者の友だち " + (k.friends === null ? "-" : k.friends) + "人。必要な友だち数は、関心ありの実績が3件たまってから出します（いまは関心化率が既定値のため）"));
    else box.appendChild(bar("👥 未加入者の友だち", k.friends === null ? 0 : k.friends, k.friendNeed));
    box.appendChild(el("div", "hint", "関心化率 " + Math.round(k.meetRate * 100) + "%" + (k.provisional ? "（既定値。実績で自動更新）" : "") + "・加入率（関心あり→加入） " + hitRateText(k)));
    if (k.hitProvisional) box.appendChild(el("div", "hint", "必要な関心あり数は、実測が出るまでの仮の目安（6人に1人が加入するとした置き）です。関心ありになった人が " + ((k.hitMinN) || 5) + "人になると、実測の加入率で計算し直します"));
  } else {
    box.appendChild(el("div", "hint", "目標が未設定です。役員会で決まるまで仮の値でも動きます"));
  }
  var pct = function(a, b){ return b ? Math.round(a / b * 100) + "%" : "-"; };
  if (k.newMembers) box.appendChild(el("div", "", "🌱 " + (k.year || "今年") + "年の新会員 " + k.newMembers + "人、うち加入後にイベント参加 " + k.settled + "人"));
  box.appendChild(el("div", "t", "🏅 紹介実績（友だち／相談／加入）"));
  if (!(k.ranking || []).length) box.appendChild(el("div", "hint", "まだありません（申込の「ご紹介者」欄から集計）"));
  (k.ranking || []).slice(0, 3).forEach(function(r, i){ box.appendChild(el("div", "", (i + 1) + ". " + r.name + " " + r.count + "／" + r.meet + "／" + r.joined)); });
  var more = document.createElement("details"); var sm = document.createElement("summary"); sm.textContent = "詳しく見る（ファネル・きっかけ別・QR別・有料化の目安）"; sm.style.cssText = "color:var(--blue);padding:8px 0;cursor:pointer"; more.appendChild(sm);
  var fun = [["QR読み取り", k.reads, ""], ["未加入者の友だち", k.friends === null ? "-" : k.friends, ""], ["申込（人）", k.applied, pct(k.applied, k.friends)], ["参加", k.attended, pct(k.attended, k.applied)], ["相談", k.nyukai, ""], ["相談以上", k.meetingsAll != null ? k.meetingsAll : k.meetings, ""], ["加入", k.joinedAll != null ? k.joinedAll : k.joined, pct(k.joinedAll != null ? k.joinedAll : k.joined, k.meetingsAll != null ? k.meetingsAll : k.meetings)]];
  more.appendChild(el("div", "t", "🔻 ファネル（累計）"));
  fun.forEach(function(f){ more.appendChild(el("div", "", "・" + f[0] + ": " + f[1] + (f[2] ? "（" + f[2] + "）" : ""))); });
  if ((k.ranking || []).length > 3){ more.appendChild(el("div", "t", "🏅 紹介実績（4位以下）")); (k.ranking || []).slice(3).forEach(function(r, i){ more.appendChild(el("div", "", (i + 4) + ". " + r.name + " " + r.count + "／" + r.meet + "／" + r.joined)); }); }
  more.appendChild(el("div", "t", "🚪 きっかけ別（友だち／相談／加入）"));
  (k.kikkake || []).forEach(function(r){ more.appendChild(el("div", "", "・" + r.name + " " + r.count + "／" + r.meet + "／" + r.joined)); });
  var en = st.entries || [];
  if (en.length){ more.appendChild(el("div", "t", "🔗 QRごとの読み取り（今月／累計）")); en.slice(0, 10).forEach(function(e){ more.appendChild(el("div", "", "・" + e.src + " " + e.month + "／" + e.total)); }); }
  more.appendChild(el("div", "", k.paid || ""));
  box.appendChild(more);
}
function saveKpi(){
  var v = $("k_target").value;
  say("更新中…");
  api("liff_admin_kpi", { target: v }).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}

// ---- 文面（3つの群・その場で編集・見本つき） ----
var TEXT_TITLE = {
  "友だち追加": "友だち追加のあいさつ", "即応": "担当が付いたときの一言（本人へ）", "紹介文": "会員が友人に送る紹介文", "加入歓迎": "加入の歓迎",
  "加入後アンケート": "加入後アンケートの案内", "青年部へ連絡": "「青年部へ連絡」への返答", "自由文の返答": "分類できないメッセージへの返答",
  "申込確認の結び": "申込確認の結びの一言", "キャンセル確認": "キャンセル確認", "前日リマインド": "前日リマインド（申込者へ）",
  "定型_御礼": "御礼", "定型_変更連絡": "変更連絡", "定型_アンケート": "アンケート依頼", "定型_当日案内": "当日案内"
};
var TEXT_DESC = {
  "友だち追加": "友だち追加の直後に届く（受付中イベントのカードが続く）", "即応": "「私が対応します」で本人に届く。{name}は担当名",
  "紹介文": "会員が友人に送る紹介文。末尾に本人専用のリンクが自動で付く", "加入歓迎": "「会員にする」の瞬間に本人へ",
  "加入後アンケート": "加入45日後に本人へ。{liff}にフォームのリンク（無ければ末尾に付く）", "青年部へ連絡": "会員メニューの「青年部へ連絡」への返答",
  "自由文の返答": "自動応答に当てはまらないメッセージへの返答（担当には転送せず、チャットで対応）",
  "申込確認の結び": "申込確認メッセージの最後の一言", "キャンセル確認": "キャンセル時に本人へ", "前日リマインド": "開催前日の朝に申込者へ。{info}は日時と場所",
  "定型_御礼": "申込者への連絡で「御礼」を押したときの文", "定型_変更連絡": "「変更連絡」を押したときの文", "定型_アンケート": "「アンケート」を押したときの文", "定型_当日案内": "「当日案内」を押したときの文",
  "相談": "この言葉が送られると返す。友だち一覧への登録と要対応はこの文面と関係なく行われる", "連盟とは": "この言葉が送られると返す", "問い合わせ": "この言葉が送られると返す"
};
var SCENE_KEYS = ["友だち追加", "即応", "紹介文", "加入歓迎", "よくある質問", "自由文の返答", "申込確認の結び", "キャンセル確認", "前日リマインド"];
var PLACEHOLDERS = [["{name}", "相手の名前"], ["{event}", "イベント名"], ["{date}", "開催日"], ["{time}", "時間"], ["{place}", "場所"], ["{fee}", "参加費"], ["{map}", "地図"], ["{liff}", "申込ページ"], ["{admin}", "担当名"], ["{info}", "日時と場所"]];
var OPEN_TEXT_KEY = null;
function textByKey(key){ return (STATE && STATE.texts || []).filter(function(t){ return t.key === key; })[0]; }
function textGroup(t){ if (t.key.indexOf("定型_") === 0) return "preset"; if (SCENE_KEYS.indexOf(t.key) >= 0) return "scene"; return "auto"; }
function sampleCtx(){
  return { name: "山田太郎", admin: myName() || "（担当名）", event: "10月の意見交換会", date: "10月15日（木）", time: "19:00〜21:00", place: "静岡市内の会場", fee: "無料", map: "https://maps.app.goo.gl/xxxx", liff: "https://liff.line.me/…（申込ページ）", info: "📅 10月15日（木） 19:00〜21:00\n📍 静岡市内の会場" };
}
function renderTexts(st){
  var box = $("a_texts"); if (!box) return; box.innerHTML = "";
  var list = st.texts || [];
  var groups = [["auto", "🔁 自動応答（この言葉が送られると返す）"], ["scene", "📨 場面ごとの文面（仕組みが自動で送る）"], ["preset", "📝 申込者への連絡の定型文（ボタンで挿入）"]];
  groups.forEach(function(g){
    var items = list.filter(function(t){ return textGroup(t) === g[0]; });
    if (!items.length && g[0] !== "auto") return;
    var grp = el("div", "panel tx-grp");
    grp.appendChild(el("div", "t", g[1]));
    if (!items.length) grp.appendChild(el("div", "hint", "まだありません"));
    items.forEach(function(t){
      var row = el("div", "tx-row" + (OPEN_TEXT_KEY === t.key ? " on" : "")); row.onclick = function(){ openText(t.key); };
      var head = el("div", "tx-head");
      var title = TEXT_TITLE[t.key] || t.key;
      head.appendChild(el("span", "tx-name", title));
      if (g[0] === "auto" && title !== t.key) head.appendChild(el("span", "tag", "「" + t.key + "」で反応"));
      if (g[0] === "auto" && !t.enabled) head.appendChild(el("span", "tag abs", "停止中"));
      if (g[0] === "auto" && t.notify) head.appendChild(el("span", "tag man", "担当に通知"));
      if (/青年部で確認して入力/.test(t.text)) head.appendChild(el("span", "tag cxl", "仮の本文・未掲載"));
      head.appendChild(el("span", "tx-arrow", OPEN_TEXT_KEY === t.key ? "▾" : "›"));
      row.appendChild(head);
      row.appendChild(el("div", "tx-body", t.text.replace(/\n+/g, " ／ ")));
      grp.appendChild(row);
      if (OPEN_TEXT_KEY === t.key) grp.appendChild(textEditor(t));
    });
    box.appendChild(grp);
  });
  if (OPEN_TEXT_KEY === "") box.appendChild(textEditor(null));
}
function textEditor(t){
  var isNew = !t;
  var wrap = el("div", "sub"); wrap.id = "text_editor";
  wrap.appendChild(el("div", "t", isNew ? "自動応答を追加" : (TEXT_TITLE[t.key] || t.key)));
  if (!isNew && TEXT_DESC[t.key]) wrap.appendChild(el("div", "hint", TEXT_DESC[t.key]));
  if (isNew){ wrap.appendChild(el("label", "", "相手が送る言葉（完全一致）")); var k = document.createElement("input"); k.id = "t_key"; k.placeholder = "例: 会費"; wrap.appendChild(k); }
  wrap.appendChild(el("label", "", "本文"));
  var ta = document.createElement("textarea"); ta.id = "t_text"; ta.rows = 9; ta.value = isNew ? "" : t.text; ta.style.fontSize = "14px"; setTimeout(function(){ autosizeTA(ta); }, 0); ta.style.lineHeight = "1.5";
  ta.oninput = function(){ updatePreview(); };
  wrap.appendChild(ta);
  var chips = el("div", "apl"); chips.style.flexWrap = "wrap"; chips.style.marginTop = "6px";
  chips.appendChild(el("small", "", "差し込み: "));
  PLACEHOLDERS.forEach(function(p){ var b = el("button", "", p[1]); b.title = p[0]; b.style.fontSize = "11px"; b.onclick = function(){ insertAtCursor(ta, p[0]); }; chips.appendChild(b); });
  wrap.appendChild(chips);
  wrap.appendChild(el("div", "hint", "見本（差し込みは例の値）:"));
  var pv = el("div", ""); pv.id = "t_preview"; pv.style.cssText = "white-space:pre-wrap;background:var(--panel);border-radius:8px;padding:10px;font-size:14px;margin:4px 0 8px";
  wrap.appendChild(pv);
  var group = isNew ? "auto" : textGroup(t);
  if (group === "auto"){
    var l1 = el("label", ""); l1.style.fontWeight = "normal"; var c1 = document.createElement("input"); c1.type = "checkbox"; c1.id = "t_enabled"; c1.style.width = "auto"; c1.checked = isNew ? true : t.enabled; l1.appendChild(c1); l1.appendChild(document.createTextNode(" この言葉が送られたら自動で返す")); wrap.appendChild(l1);
    var l2 = el("label", ""); l2.style.fontWeight = "normal"; var c2 = document.createElement("input"); c2.type = "checkbox"; c2.id = "t_notify"; c2.style.width = "auto"; c2.checked = isNew ? false : t.notify; l2.appendChild(c2); l2.appendChild(document.createTextNode(" 送られたら担当に知らせる（重要通知の送り先へ）")); wrap.appendChild(l2);
  }
  var btns = el("div", ""); btns.style.cssText = "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap";
  var mk = function(label, fn, style){ var b = el("button", "", label); b.onclick = fn; b.style.cssText = "flex:1;" + (style || ""); btns.appendChild(b); };
  mk("保存", function(){ saveText(isNew ? "" : t.key); }, "background:var(--navy);color:#fff");
  mk("自分に送ってみる", function(){ testText(isNew ? "" : t.key); });
  if (group === "auto" && !isNew) mk("削除", function(){ deleteText(t.key); }, "background:#999;color:#fff");
  mk("閉じる", function(){ OPEN_TEXT_KEY = null; renderTexts(STATE); });
  wrap.appendChild(btns);
  setTimeout(updatePreview, 0);
  return wrap;
}
function updatePreview(){ var ta = $("t_text"), pv = $("t_preview"); if (ta && pv) pv.textContent = fillTplClient(ta.value, sampleCtx()) || "（本文が空です）"; }
function insertAtCursor(ta, text){
  var s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length; ta.focus(); updatePreview();
}
function openText(key){
  OPEN_TEXT_KEY = key;
  renderTexts(STATE);
  var ed = $("text_editor"); if (ed) setTimeout(function(){ ed.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 50);
}
function textData(op, key){
  var t = key ? textByKey(key) : null;
  var isNew = !t;
  return { op: op, key: isNew ? ($("t_key") ? $("t_key").value.trim() : "") : t.key, text: $("t_text").value,
           enabled: $("t_enabled") ? $("t_enabled").checked : (t ? t.enabled : false), notify: $("t_notify") ? $("t_notify").checked : (t ? t.notify : false) };
}
function saveText(key){
  var d = textData("set", key);
  if (!d.key){ alert("相手が送る言葉を入力してください"); return; }
  if (!d.text.trim()){ alert("本文を入力してください"); return; }
  KEEP_SCROLL = true; say("保存中…");
  api("liff_admin_text", { data: d }).then(function(st){ OPEN_TEXT_KEY = d.key; renderAdmin(st); }).catch(function(e){ say("エラー: " + e.message); });
}
function testText(key){
  var d = textData("test", key);
  if (!d.text.trim()){ alert("本文を入力してください"); return; }
  KEEP_SCROLL = true; say("送信中…");
  var text = d.text;
  api("liff_admin_text", { data: d }).then(function(st){ renderAdmin(st); var ta = $("t_text"); if (ta) { ta.value = text; updatePreview(); } }).catch(function(e){ say("エラー: " + e.message); });
}
function deleteText(key){
  if (!confirm("「" + key + "」を削除しますか？")) return;
  KEEP_SCROLL = true;
  api("liff_admin_text", { data: { op: "delete", key: key } }).then(function(st){ OPEN_TEXT_KEY = null; renderAdmin(st); }).catch(function(e){ say("エラー: " + e.message); });
}
function rebuildMenus(){
  if (!confirm("通常・管理者・会員の3種のメニューを作り直します（1分ほど）。よろしいですか？")) return;
  say("作り直しています…");
  api("liff_admin_menus", {}).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}
// 差し込み（クライアント側。定型文の挿入用）
function fillTplClient(text, ctx){
  var t = String(text || "");
  Object.keys(ctx || {}).forEach(function(k){ t = t.split("{" + k + "}").join(ctx[k] == null ? "" : String(ctx[k])); });
  return t.split("\n").filter(function(l){ return !/^[^:：]{1,12}[:：]\s*$/.test(l); }).join("\n");
}

document.addEventListener("keydown", function(ev){
  if (ev.key === "Escape"){ if (DETAIL_ID !== null && DETAIL_ID !== undefined && $("case_detail").style.display !== "none") closeDetail(); }
  if (MODE === "admin" && /^[1-7]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !/INPUT|TEXTAREA|SELECT/.test(ev.target && ev.target.tagName || "")){
    showView(["todo", "cases", "event", "members", "stats", "texts", "help"][Number(ev.key) - 1]);
  }
  if (ev.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(ev.target && ev.target.tagName || "")){ var q = document.querySelector("section.vw.on input[id$='_q']"); if (q){ ev.preventDefault(); q.focus(); } }
});
window.addEventListener("resize", function(){ placePreview(); if (STATE && STATE.all && MODE === "admin") renderAll(); });
// 配信カードのプレビュー: PC では右の列（申込者の上）、スマホではフォームの中（保存ボタンの上）
function placePreview(){
  var pv = $("pv_wrap"), right = $("ev_right"), form = $("ev_form"); if (!pv || !right || !form) return;
  if (window.innerWidth >= 900){ if (pv.parentNode !== right) right.insertBefore(pv, right.firstChild); pv.style.marginTop = "0"; }
  else if (pv.parentNode !== form){ form.insertBefore(pv, $("a_save")); pv.style.marginTop = "16px"; }
}

// PCで開きっぱなしでも最新に: 5分ごと（タブが見えているときだけ）。詳細や文面の編集中は次の機会に
var AUTO_REFRESH_MS = 5 * 60 * 1000;
function autoRefresh(){
  if (MODE !== "admin" || !STATE || document.hidden) return;
  if (NW_SENDING || Object.keys(NW_QUEUE).length) return; // ★／× の保存中は、古い写しで上書きしない
  if ((DETAIL_ID !== null && DETAIL_ID !== undefined && $("case_detail").style.display !== "none") || OPEN_TEXT_KEY !== null) return;
  if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  KEEP_SCROLL = true;
  fastBootstrap("liff_admin_bootstrap").then(function(st){ renderAdmin(st); say("最新の情報に更新しました（" + new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) + "）"); }).catch(function(){});
}
setInterval(autoRefresh, AUTO_REFRESH_MS);
document.addEventListener("visibilitychange", function(){
  if (document.hidden){ flushNewsPicks(); return; } // 押した直後に閉じても消えないように、先に送る
  if (MODE === "admin" && STATE) autoRefresh();
});

function closeLiff(){
  flushNewsPicks();
  try { liff.closeWindow(); } catch (e) { $("done").style.display = "none"; }
}

/* ---------- 管理者モード ---------- */

$("a_img").addEventListener("change", function(ev){
  var f = ev.target.files[0];
  if (!f) return;
  var r = new FileReader();
  r.onload = function(){
    var im = new Image();
    im.onload = function(){
      var w = Math.min(1200, im.width);
      var h = Math.round(im.height * w / im.width);
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(im, 0, 0, w, h);
      A_IMG = c.toDataURL("image/jpeg", 0.85);
      A_RATIO = w + ":" + h;
      $("a_prev").src = A_IMG;
      $("a_prev").style.display = "block";
      $("a_rmimg").checked = false;
      updatePreview();
    };
    im.src = r.result;
  };
  r.readAsDataURL(f);
});

// 開催日を入れたら締切日を2日前で自動提案（締切が空欄のときだけ）
$("a_date").addEventListener("change", function(){
  if ($("a_deadline").value) return;
  var m = $("a_date").value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 2);
  var pad = function(n){ return (n < 10 ? "0" : "") + n; };
  $("a_deadline").value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  updatePreview();
});

function curEvent(name){ return STATE && STATE.events ? (STATE.events.filter(function(e){ return e.name === name; })[0] || null) : null; }

function updatePreview(){
  var name = $("a_name").value.trim();
  $("pv_name").textContent = name || "（イベント名）";
  $("pv_date").textContent = "📅 " + jpDate($("a_date").value) + " " + $("a_time").value;
  $("pv_place").textContent = "📍 " + $("a_place").value;
  var fee = $("a_fee").value.trim();
  $("pv_fee").style.display = fee ? "block" : "none"; $("pv_fee").textContent = "💰 参加費 " + fee;
  var cap = Number($("a_cap").value);
  var cur = curEvent(name);
  var cnt = cur ? cur.count : 0;
  $("pv_rem").style.display = cap > 0 ? "block" : "none"; $("pv_rem").textContent = "🪑 定員" + cap + "名";
  $("pv_desc").textContent = $("a_desc").value;
  var dl = $("a_deadline").value;
  $("pv_btn").textContent = "参加する" + (dl ? "（締切" + jpDate(dl) + "）" : "");
  $("pv_map").style.display = /^https?:\/\//.test($("a_map").value.trim()) ? "block" : "none";
  var src = $("a_rmimg").checked ? "" : (A_IMG || ($("a_prev").style.display === "block" ? $("a_prev").src : ""));
  if (!src && !$("a_rmimg").checked) src = "assets/banner.png"; // 画像なし＝配信カードには文字ロゴの既定バナーが載る
  if (src){ $("pv_img").src = src; $("pv_img").style.display = "block"; } else { $("pv_img").style.display = "none"; }
}
["a_name","a_date","a_time","a_place","a_desc","a_deadline","a_fee","a_map","a_cap"].forEach(function(id){ $(id).addEventListener("input", updatePreview); });

// 受付中→予約あり→受付終了→終了・停止 の順に並べる
function sortedEvents(evs){
  var rank = function(e){ if (e.past || !e.active) return 3; if (e.open) return 0; if (e.scheduleAt) return 1; return 2; };
  return evs.slice().sort(function(a, b){ var r = rank(a) - rank(b); if (r) return r; return (a.date || "").localeCompare(b.date || ""); });
}

function renderAdmin(st){
  var keepY = window.scrollY;
  STATE = st;
  placePreview();
  // 外形監視（Cloudflare の定期実行が GAS の点検を叩いた結果）。問題があるときだけ上に出す
  var hb = $("health_banner"), h = st.health;
  if (hb){
    var stale = !!(h && h.at && Date.now() - new Date(h.at).getTime() > 36 * 3600 * 1000);
    if (h && (!h.reachable || !h.ok || stale)){
      hb.style.display = "block";
      hb.textContent = (!h.reachable ? "⚠️ 外形監視: GAS に到達できませんでした（" + String(h.at || "").slice(0, 16) + "）" : stale ? "⚠️ 外形監視の結果が古いです（" + String(h.at).slice(0, 16) + "）。Cloudflare の定期実行を確認" : "⚠️ 直近の点検で問題があります（" + String(h.at || "").slice(0, 16) + "）")
        + ((h.warnings || []).length ? "\n" + (h.warnings || []).slice(0, 5).join("\n") : "")
        + "\n直したあとは 設定 →「外形監視を今実行」で更新できます（開き直しでも数分内に自動で更新）";
    } else hb.style.display = "none";
  }
  document.body.classList.add("admin");
  document.title = "管理画面 - 静岡県看護連盟 公式LINE";
  if (!INTRO_CHECKED){ INTRO_CHECKED = true; showIntro(false); }
  $("user_ui").style.display = "none";
  $("admin_ui").classList.add("shown");
  showDbg("admin panel rendered");
  if (st.message){ say(st.message); } else { say("管理メニュー（イベントの作成・修正・配信）"); }
  var s = $("a_ev");
  var cur = s.value;
  s.innerHTML = "<option value=''>（新規作成）</option>";
  sortedEvents(visibleEvents(st)).forEach(function(e){
    var o = document.createElement("option");
    o.value = e.name;
    var state = (e.past || !e.active) ? "終了" : (e.open ? "受付中" : "受付終了");
    var extra = (e.broadcastAt ? "・配信済" + e.broadcastAt : "") + (e.scheduleAt ? "・予約" + e.scheduleAt.replace("T", " ") : "");
    o.textContent = (state === "終了" ? "（終了）" : "") + e.name + "（申込" + e.count + (e.cap ? "/" + e.cap : "") + "・" + state + extra + "）";
    s.appendChild(o);
  });
  if (cur) s.value = cur;
  fillSelect("m_kubun", st.kubunList || [], ""); fillSelect("m_kikkake", st.keiroList || [], "");
  // 送信に失敗した宛先が残っていれば、失敗分だけ送り直せるようにする
  var rb = $("ops_resend"), rn = $("ops_resend_note");
  if (rb && rn){
    if (st.resend && st.resend.n){
      rb.style.display = "inline-block"; rn.style.display = "block";
      rn.textContent = "⚠️ " + st.resend.at + " の「" + st.resend.label + "」で " + st.resend.n + "名に届いていません。「失敗分を再送」で同じ本文をその人たちにだけ送り直せます";
    } else { rb.style.display = "none"; rn.style.display = "none"; }
  }
  fillSelect("n_kubun", st.kubunList || [], ""); fillSelect("n_shokuba", st.shokubaList || [], ""); fillSelect("n_kikkake", st.keiroList || [], "");
  fillDatalist(st.memberNames);
  var lines = [];
  var q = st.quota || {};
  lines.push("📤 今月の配信通数: " + (q.used === null || q.used === undefined ? "取得不可" : q.used + (q.limit ? "／" + q.limit : "")) + (q.limit && q.used >= q.limit * 0.8 ? "（上限が近い→有料プラン検討）" : ""));
  var fi = st.insight || {};
  if (fi.followers !== null && fi.followers !== undefined) lines.push("👥 友だち " + fi.followers + "人（ブロック " + fi.blocks + "・" + fi.date + "時点）うち会員・担当 " + (st.memberCount || 0) + "人 → 未加入者 " + Math.max(0, fi.followers - (st.memberCount || 0)) + "人");
  else lines.push("👥 友だち数: 集計待ち（前日分が翌日に反映）");
  visibleEvents(st).forEach(function(e){ lines.push("🎫 " + e.name + ": " + e.count + (e.cap ? "／定員" + e.cap : "") + "件" + (e.broadcastAt ? "（配信済 " + e.broadcastAt + "）" : "（未配信）") + (e.deadlineRemind ? "（締切前配信 " + e.deadlineRemindAt + "）" : "") + (e.reach ? "／到達: " + e.reach : "") + (e.thanksSent ? "／御礼 " + e.thanksSent : "") + (e.dayStats ? "／当日: QR読み取り " + e.dayStats.reads + "・友だち追加 " + e.dayStats.adds + "・申込 " + e.dayStats.applies : "")); });
  var total = 0; Object.keys(st.stats || {}).forEach(function(k){ total += st.stats[k]; });
  lines.push("📋 友だち一覧: " + total + "人");
  var en = st.entries || [];
  lines.push(en.length ? "🔗 QR読み取り（今月／累計）: " + en.slice(0, 8).map(function(e){ return e.src + " " + e.month + "／" + e.total; }).join("、") : "🔗 QR読み取り: まだありません");
  if (st.tantoText) lines.push(st.tantoText);
  if (st.dupText) lines.push(st.dupText);
  if (st.worker) lines.push(st.worker);
  if (st.targetsText) lines.push("📨 " + st.targetsText);
  lines.push("🔑 管理者: " + (st.admins || []).map(function(a){ return a.name; }).join("、") + "（追加は「管理者招待」、自分を外すのは「管理者解除」）");
  $("a_stats").innerHTML = "";
  var kv = document.createElement("table"); kv.className = "kv";
  lines.forEach(function(t){
    var tr = document.createElement("tr"), m = String(t).match(/^([^:：]{1,24})[:：]\s*(.*)$/s);
    if (m){ var a = document.createElement("td"); a.textContent = m[1]; var b = document.createElement("td"); b.textContent = m[2]; tr.appendChild(a); tr.appendChild(b); }
    else { var c = document.createElement("td"); c.colSpan = 2; c.textContent = t; tr.appendChild(c); }
    kv.appendChild(tr);
  });
  $("a_stats").appendChild(kv);
  $("a_sheet").href = st.sheetUrl;
  renderEventTable(st);
  renderCases(st);
  renderAll();
  if (DETAIL_ID) fillDetail(DETAIL_ID);
  renderMembers(st);
  renderVoicesAdmin(st);
  renderNewsAdmin(st);
  renderKpi(st);
  renderTexts(st);
  renderApplicants();
  if (!VIEW_CUR){
    VIEW_CUR = { cases: "todo", roster: "cases", kpi: "stats", event: "event", texts: "texts", members: "members", todo: "todo", stats: "stats", voices: "voices", map: "voices", news: "news" }[VIEW] || "todo";
  }
  showView(VIEW_CUR);
  if (keepY) setTimeout(function(){ window.scrollTo({ top: keepY }); }, 0);
  updatePreview();
  $("ev_copy").style.display = $("a_ev").value ? "inline-block" : "none";
  var evd = $("ev_del"); if (evd) evd.style.display = $("a_ev").value ? "inline-block" : "none";
}

function renderApplicants(){
  var n = $("a_ev").value;
  var e = curEvent(n);
  var panel = $("apl_panel");
  if (!e){ panel.style.display = "none"; return; }
  panel.style.display = "block";
  $("apl_title").textContent = "申込者一覧（" + e.name + "・" + e.count + "件・" + (e.people || e.count) + "人）";
  var list = $("apl_list"); list.innerHTML = "";
  var cnt = { att: 0, abs: 0, cxl: 0, none: 0 };
  e.applicants.forEach(function(a){ if (a.taio === "参加") cnt.att++; else if (a.taio === "欠席") cnt.abs++; else if (a.taio === "キャンセル") cnt.cxl++; else cnt.none++; });
  $("apl_stats").textContent = "参加 " + cnt.att + "・欠席 " + cnt.abs + "・未記録 " + cnt.none + (cnt.cxl ? "・キャンセル " + cnt.cxl : "");
  if (!e.applicants.length){ list.appendChild(el("div", "hint", "まだ申込はありません")); return; }
  var q = ($("apl_q").value || "").trim().toLowerCase();
  var shown = e.applicants.filter(function(a){ return !q || (a.name + " " + (a.kubun || "")).toLowerCase().indexOf(q) >= 0; });
  if (!shown.length){ list.appendChild(el("div", "hint", "該当なし")); return; }
  shown.forEach(function(a){
    var row = el("div", "apl");
    var nm = el("div", "nm");
    nm.appendChild(el("div", "", a.name + (a.kubun ? "（" + a.kubun + "）" : "") + (a.dohanCount ? " 同伴" + a.dohanCount + "名" + (a.dohan ? "(" + a.dohan + ")" : "") : "")));
    nm.appendChild(el("small", "", (a.contact || "") + (a.kikkake ? "・" + a.kikkake : "") + (a.hasLine ? "" : "・LINE未紐付") + (a.member ? "・会員" : "")));
    row.appendChild(nm);
    if (a.manual) row.appendChild(el("span", "tag man", "代理"));
    if (a.taio === "キャンセル"){
      row.appendChild(el("span", "tag cxl", "キャンセル"));
    } else {
      if (a.taio === "参加") row.appendChild(el("span", "tag att", "参加"));
      else if (a.taio === "欠席") row.appendChild(el("span", "tag abs", "欠席"));
      var bAtt = el("button", "b_att", "参加"); bAtt.onclick = function(){ setAttend(e.name, a.row, "参加", a); };
      var bAbs = el("button", "b_abs", "欠席"); bAbs.onclick = function(){ setAttend(e.name, a.row, "欠席", a); };
      row.appendChild(bAtt); row.appendChild(bAbs);
      if (a.taio){ var bClr = el("button", "b_clr", "戻す"); bClr.onclick = function(){ setAttend(e.name, a.row, "", a); }; row.appendChild(bClr); }
    }
    list.appendChild(row);
  });
}

function setAttend(ev, row, status, a){
  if (!(row > 0)){ alert("台帳への記録待ちです。数秒後にもう一度お試しください"); return; }
  say("記録中…");
  // 行番号だけでなく、その人の名前・LINE_userId も渡す（写しが古くて行がずれていても別人に付かない）
  api("liff_admin_attend", { ev: ev, row: row, status: status, key: a ? { name: a.name || "", uid: a.uid || "" } : {} }).then(renderAdmin).catch(function(e){ say("エラー: " + e.message); });
}

function insertTpl(kind){
  var n = $("a_ev").value;
  var e = curEvent(n);
  var when = e ? jpDate(e.date) + " " + e.time : "";
  var keys = { thanks: "定型_御礼", change: "定型_変更連絡", survey: "定型_アンケート", remind: "定型_当日案内" };
  var t = textByKey(keys[kind]);
  var ctx = { event: e ? e.name : "イベント", date: e ? jpDate(e.date) : "", time: e ? e.time : "", place: e ? e.place : "", fee: e ? e.fee : "", map: e ? e.mapUrl : "" };
  $("a_msg").value = t ? fillTplClient(t.text, ctx) : "";
  $("a_msg").focus();
}

function adminMessage(){
  var n = $("a_ev").value;
  var text = $("a_msg").value.trim();
  if (!n){ alert("先にイベントを選んでください"); return; }
  if (!text){ alert("本文を入力してください"); return; }
  var e = curEvent(n);
  var cnt = e ? e.applicants.filter(function(a){ return a.hasLine && a.taio !== "キャンセル" && a.taio !== "欠席"; }).length : 0;
  if (!confirm("「" + n + "」の申込者" + cnt + "名にLINEで送信します。よろしいですか？")) return;
  $("a_send").disabled = true;
  say("送信中…");
  api("liff_admin_message", { ev: n, text: text }).then(function(st){ $("a_send").disabled = false; $("a_msg").value = ""; renderAdmin(st); })
    .catch(function(e){ $("a_send").disabled = false; say("エラー: " + e.message); });
}

function adminAddApply(){
  var n = $("a_ev").value;
  if (!n){ alert("先にイベントを選んでください"); return; }
  var d = { name: $("m_name").value.trim(), kubun: $("m_kubun").value, contact: $("m_contact").value,
            dohan: $("m_dohan").value, dohanCount: $("m_dohan_count").value, kikkake: $("m_kikkake").value, shokai: $("m_shokai").value, memo: $("m_memo").value,
            consent: $("m_consent").checked, consentBy: $("m_consent_by").value.trim(), force: $("m_force").checked };
  if (!d.name){ alert("お名前を入力してください"); return; }
  if (!d.consent){ alert("本人に説明して口頭で同意を確認したチェックを入れてください"); $("m_consent").focus(); return; }
  if (!d.consentBy){ alert("確認した担当のお名前を入れてください"); $("m_consent_by").focus(); return; }
  say("追加中…");
  api("liff_admin_add_apply", { ev: n, data: d }).then(function(st){
    ["m_name","m_contact","m_dohan","m_shokai","m_memo"].forEach(function(id){ $(id).value = ""; });
    $("m_kubun").value = ""; $("m_kikkake").value = ""; $("m_dohan_count").value = "0";
    $("m_consent").checked = false; $("m_force").checked = false;
    renderAdmin(st);
  }).catch(function(e){ say("エラー: " + e.message); });
}

function clearForm(){
  ["a_name","a_date","a_time","a_place","a_desc","a_deadline","a_cap","a_fee","a_map","a_sched"].forEach(function(id){ $(id).value = ""; });
  $("a_active").checked = true; $("a_dlremind").checked = false; $("a_thanks").checked = true;
  A_IMG = ""; A_RATIO = ""; COPY_FROM = ""; $("a_prev").style.display = "none"; $("a_img").value = ""; $("a_rmimg").checked = false;
}

function adminLoad(){
  setTimeout(autosizeAll, 0); // 読み込んだ案内文の長さに欄を合わせる
  var n = $("a_ev").value;
  clearForm();
  $("ev_copy").style.display = n ? "inline-block" : "none";
  $("ev_editing").textContent = n ? "編集中: " + n + "（保存すると上書き）" : "新規作成";
  var evd2 = $("ev_del"); if (evd2) evd2.style.display = n ? "inline-block" : "none";
  if (!n){ renderApplicants(); updatePreview(); return; }
  var e = curEvent(n);
  if (!e) return;
  $("a_name").value = e.name; $("a_date").value = e.date; $("a_time").value = e.time;
  $("a_place").value = e.place; $("a_desc").value = e.desc; $("a_deadline").value = e.deadline;
  $("a_cap").value = e.cap; $("a_fee").value = e.fee; $("a_map").value = e.mapUrl; $("a_sched").value = e.scheduleAt || "";
  $("a_active").checked = e.active; $("a_dlremind").checked = !!e.deadlineRemind; $("a_thanks").checked = (e.thanksAuto !== false);
  $("a_target").value = e.target || "全員";
  if (e.img){ $("a_prev").src = e.img; $("a_prev").style.display = "block"; }
  renderApplicants();
  updatePreview();
  say("読み込みました（画像は再選択したときだけ差し替わります）" + (e.broadcastAt ? "／配信済 " + e.broadcastAt : ""));
}

// 複製: 読込中のイベントを元に新規作成（日付・締切・予約・配信情報は空にする。画像は引き継ぐ）
function adminCopy(){
  var n = $("a_ev").value;
  var e = curEvent(n);
  if (!e) return;
  COPY_FROM = e.name;
  $("a_ev").value = "";
  $("ev_copy").style.display = "none";
  $("ev_editing").textContent = "「" + e.name + "」を複製中（新規のイベントとして保存されます）";
  $("a_name").value = e.name + "（コピー）";
  $("a_time").value = e.time; $("a_place").value = e.place; $("a_desc").value = e.desc;
  $("a_cap").value = e.cap; $("a_fee").value = e.fee; $("a_map").value = e.mapUrl;
  $("a_date").value = ""; $("a_deadline").value = ""; $("a_sched").value = ""; $("a_dlremind").checked = false; $("a_thanks").checked = true; $("a_active").checked = true;
  A_IMG = ""; A_RATIO = ""; $("a_img").value = ""; $("a_rmimg").checked = false;
  if (e.img){ $("a_prev").src = e.img; $("a_prev").style.display = "block"; } else { $("a_prev").style.display = "none"; }
  renderApplicants();
  updatePreview();
  say("複製しました。イベント名と開催日を直して保存してください（画像は元のイベントから引き継ぎます）");
  $("a_name").focus();
}

function adminSave(mode){
  var d = { name: $("a_name").value.trim(), date: $("a_date").value, time: $("a_time").value,
            place: $("a_place").value, desc: $("a_desc").value, deadline: $("a_deadline").value,
            cap: $("a_cap").value, fee: $("a_fee").value.trim(), mapUrl: $("a_map").value.trim(),
            scheduleAt: $("a_sched").value || "", active: $("a_active").checked, target: $("a_target").value || "全員",
            deadlineRemind: $("a_dlremind").checked, thanksAuto: $("a_thanks").checked,
            imageBase64: A_IMG, imageRatio: A_RATIO, removeImage: $("a_rmimg").checked, copyImageFrom: COPY_FROM,
            origName: $("a_ev").value || "" }; // 読み込んだイベントの元の名前（変えたときは申込も追随する）
  if (!d.name){ alert("イベント名は必須です"); return; }
  if (d.mapUrl && !/^https:\/\//.test(d.mapUrl)){ alert("地図URLは https:// から始まるリンクを入れてください"); return; }
  var cur = curEvent(d.name);
  if (!$("a_ev").value && cur && !confirm("同じ名前のイベント「" + d.name + "」が既にあります。上書きしますか？")) return;
  if (mode === "all"){
    var warn = "保存して、友だち全員に今すぐ配信します。よろしいですか？";
    if (cur && cur.broadcastAt) warn = "このイベントは " + cur.broadcastAt + " に配信済みです。もう一度全員に配信しますか？";
    if (!confirm(warn + "\n（先に「自分にだけテスト送信」で実物を確認するのがおすすめです）")) return;
  }
  var btns = ["a_save","a_test","a_savebc"];
  btns.forEach(function(id){ $(id).disabled = true; });
  say(mode === "all" ? "保存して全員に配信中…" : mode === "test" ? "保存してテスト送信中…" : "保存中…");
  api("liff_admin_save", { data: d, broadcast: mode }).then(function(st){
    btns.forEach(function(id){ $(id).disabled = false; });
    A_IMG = ""; A_RATIO = ""; COPY_FROM = ""; $("a_rmimg").checked = false;
    $("a_ev").value = d.name;
    renderAdmin(st);
    $("ev_copy").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }).catch(function(e){ btns.forEach(function(id){ $(id).disabled = false; }); say("エラー: " + e.message); });
}

boot();
