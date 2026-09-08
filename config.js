// この団体の設定。デモ→本番の移行は、ここと go.html の meta refresh の URL だけを差し替える
// 値の取り方は README_デモ手順.md「0. 用意するものと、取った値の貼り先」を参照
window.SITE_CONFIG = {
  // LINE Developers → LINE Login チャネル → LIFF タブ → 追加した LIFF アプリの「LIFF ID」
  LIFF_ID: "2011511250-U8IKfZs3",
  // GAS → デプロイ → ウェブアプリの URL（.../exec）
  API: "https://script.google.com/macros/s/AKfycbx2OsPRFh3snhGZ526DRoGlBugB1-GHQIeffGaQ_1Hh9DCK34nRgtKnrfRjxecjoZYO/exec",
  // Cloudflare Worker の URL（npx wrangler deploy の出力）。使わないなら "" のまま
  WORKER: "https://kango-line-api.election-dashboard-2026.workers.dev",
  // LINE Official Account Manager →「友だちを増やす」に出る友だち追加 URL（短縮リンク）
  ADD_URL: "",
  ORG: "静岡県看護連盟"
};
