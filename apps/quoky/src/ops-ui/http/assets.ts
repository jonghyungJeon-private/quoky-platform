/**
 * The two static assets of the operations UI (ADR-0113 D1/D4), served from these constants at `/ops.css` and
 * `/ops.js`. Pages never carry inline style or script; all styling lives here and all behaviour lives in the script.
 * Neither asset carries data.
 */

/** Lower bound of the dashboard poll (ADR-0113 D6: a bounded poll of at least 10 s). */
export const OPS_UI_MIN_REFRESH_SECONDS = 10;
export const OPS_UI_DEFAULT_REFRESH_SECONDS = 15;

export const OPS_UI_CSS = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1c1f24;
  --muted: #5d6573;
  --line: #d9dde3;
  --ok: #1d7a46;
  --bad: #b3261e;
  --accent: #2f5bd3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171b;
    --panel: #1d2026;
    --text: #e6e8eb;
    --muted: #9aa3b2;
    --line: #333842;
    --ok: #5cc28a;
    --bad: #f08a80;
    --accent: #8fa8f0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
header.top {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
header.top h1 { font-size: 16px; margin: 0; }
header.top .meta { color: var(--muted); font-size: 12px; }
header.top form { margin: 0; }
main { padding: 16px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
main.signin { display: block; max-width: 420px; margin: 48px auto; }
section.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  min-width: 0;
}
section.panel h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; gap: 8px; }
.state { font-size: 12px; font-weight: 600; }
.state-ok { color: var(--ok); }
.state-unavailable { color: var(--bad); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; }
p.empty, ul.notes { color: var(--muted); font-size: 12px; }
ul.notes { margin: 8px 0 0; padding-left: 18px; }
p.error { color: var(--bad); }
label { display: block; margin: 12px 0 4px; }
input[type="password"], input[type="text"] {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
button {
  margin-top: 12px;
  padding: 6px 14px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}
header.top button { margin-top: 0; }
td form { margin: 0; }
td form button, td a.action { margin-top: 0; }
a.action { color: var(--accent); }
p.links { margin: 10px 0 0; }
blockquote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--line); overflow-wrap: anywhere; }
.refresh { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.refresh label { display: inline; margin: 0; }
`;

export const OPS_UI_JS = `(function () {
  'use strict';
  var body = document.body;
  if (!body || body.getAttribute('data-page') !== 'dashboard') return;
  var seconds = parseInt(body.getAttribute('data-refresh-seconds') || '', 10);
  if (!(seconds >= ${OPS_UI_MIN_REFRESH_SECONDS})) seconds = ${OPS_UI_DEFAULT_REFRESH_SECONDS};
  var toggle = document.getElementById('auto-refresh');
  var timer = null;
  function arm() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (toggle && !toggle.checked) return;
    timer = setTimeout(function () { window.location.reload(); }, seconds * 1000);
  }
  if (toggle) toggle.addEventListener('change', arm);
  arm();
})();
`;
