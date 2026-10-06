import { OPS_UI_DEFAULT_REFRESH_SECONDS } from './assets';
import type { OpsPanelView, OpsViewModel } from './view-model';

/**
 * Server-side rendering of the operations UI (ADR-0113 D4/D5). Every dynamic string goes through {@link escapeHtml};
 * pages contain no inline `<script>`, no inline `<style>`, no `style=` attribute and no inline event handler: styling
 * comes only from `/ops.css` and behaviour only from `/ops.js`.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The one escaping helper (text and attribute values alike). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function page(title: string, bodyAttributes: string, content: string): string {
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="stylesheet" href="/ops.css">',
    '<script src="/ops.js" defer></script>',
    '</head>',
    `<body${bodyAttributes}>`,
    content,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The sign-in page: no data, only the token form (ADR-0113 D3). */
export function renderSignInPage(message?: 'INVALID' | 'LOCKED'): string {
  const notice =
    message === 'INVALID'
      ? '<p class="error">토큰이 맞지 않아요.</p>'
      : message === 'LOCKED'
        ? '<p class="error">로그인 시도가 너무 많아요. 1분 뒤에 다시 시도하세요.</p>'
        : '';
  return page(
    'Quoky 운영 화면',
    ' data-page="signin"',
    [
      '<main class="signin">',
      '<section class="panel">',
      '<h2>Quoky 운영 화면</h2>',
      '<p>호스트 데이터 디렉터리의 <code>ops-ui.token</code> 파일에 있는 토큰을 붙여 넣으세요. 토큰은 Quoky가 시작할 때마다 바뀌어요.</p>',
      notice,
      '<form method="post" action="/session" autocomplete="off">',
      '<label for="token">접속 토큰</label>',
      '<input id="token" name="token" type="password" required autocomplete="off" spellcheck="false">',
      '<button type="submit">로그인</button>',
      '</form>',
      '</section>',
      '</main>',
    ].join('\n'),
  );
}

function renderPanel(panel: OpsPanelView): string {
  const stateClass = panel.state === 'OK' ? 'state state-ok' : 'state state-unavailable';
  const stateText = panel.state === 'OK' ? 'OK' : `사용 불가${panel.errorCode ? ` · ${panel.errorCode}` : ''}`;
  const parts: string[] = [
    `<section class="panel" id="panel-${escapeHtml(panel.id)}">`,
    `<h2><span>${escapeHtml(panel.title)}</span><span class="${stateClass}">${escapeHtml(stateText)}</span></h2>`,
  ];
  if (panel.fields.length > 0) {
    parts.push('<dl>');
    for (const field of panel.fields) {
      parts.push(`<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`);
    }
    parts.push('</dl>');
  }
  if (panel.table) {
    if (panel.table.rows.length === 0) {
      parts.push(`<p class="empty">${escapeHtml(panel.table.emptyText)}</p>`);
    } else {
      parts.push('<div class="table-wrap"><table>');
      parts.push(`<thead><tr>${panel.table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`);
      parts.push('<tbody>');
      for (const row of panel.table.rows) {
        parts.push(`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`);
      }
      parts.push('</tbody></table></div>');
    }
  }
  if (panel.notes.length > 0) {
    parts.push(`<ul class="notes">${panel.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`);
  }
  parts.push('</section>');
  return parts.join('\n');
}

/** The read-only dashboard. The CSRF token rides only in the sign-out form's hidden field. */
export function renderDashboard(
  view: OpsViewModel,
  csrfToken: string,
  refreshSeconds: number = OPS_UI_DEFAULT_REFRESH_SECONDS,
): string {
  return page(
    'Quoky 운영 화면',
    ` data-page="dashboard" data-refresh-seconds="${escapeHtml(String(refreshSeconds))}"`,
    [
      '<header class="top">',
      '<div>',
      '<h1>Quoky 운영 화면 (읽기 전용)</h1>',
      `<div class="meta">갱신 시각 ${escapeHtml(view.generatedAt)}</div>`,
      '</div>',
      '<div class="refresh">',
      '<input type="checkbox" id="auto-refresh" checked>',
      `<label for="auto-refresh">${escapeHtml(String(refreshSeconds))}초마다 자동 갱신</label>`,
      '</div>',
      '<form method="post" action="/session/end">',
      `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`,
      '<button type="submit">로그아웃</button>',
      '</form>',
      '</header>',
      '<main>',
      ...view.panels.map(renderPanel),
      '</main>',
    ].join('\n'),
  );
}

/** A bare status page (refusals, not found). Fixed copy only. */
export function renderStatusPage(title: string, message: string): string {
  return page(title, ' data-page="status"', `<main class="signin"><section class="panel"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p><a href="/">처음으로</a></p></section></main>`);
}
