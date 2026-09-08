// この団体の設定。デモ→本番の移行は、ここと go.html の meta refresh の URL だけを差し替える
// 値の取り方は README_デモ手順.md「0. 用意するものと、取った値の貼り先」を参照
window.SITE_CONFIG = {
  // LINE Developers → LINE Login チャネル → LIFF タブ → 追加した LIFF アプリの「LIFF ID」
  LIFF_ID: "",
  // GAS → デプロイ → ウェブアプリの URL（.../exec）
  API: "",
  // Cloudflare Worker の URL（npx wrangler deploy の出力）。使わないなら "" のまま
  WORKER: "",
  // LINE Official Account Manager →「友だちを増やす」に出る友だち追加 URL（短縮リンク）
  ADD_URL: "",
  ORG: "静岡県看護連盟"
};
