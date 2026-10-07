import { OPS_UI_DEFAULT_REFRESH_SECONDS } from './assets';
import type {
  OpsActionOutcome,
  OpsApprovalPreview,
  OpsForgetRequest,
  OpsLink,
  OpsMemoryList,
  OpsPanelView,
  OpsReminderCancelPreview,
  OpsViewModel,
} from './view-model';

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
    '<meta name="referrer" content="same-origin">',
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

/** A same-origin absolute path only (`/x`, never `//host`, a scheme or a backslash). */
export function isLocalHref(href: string): boolean {
  return /^\/(?![/\\])[A-Za-z0-9/_.?=&%-]*$/.test(href);
}

function renderLink(link: OpsLink): string {
  return isLocalHref(link.href) ? `<a class="action" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>` : '';
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
      const rowLinks = panel.table.rowLinks;
      const withLinks = rowLinks !== undefined && rowLinks.some((link) => link !== null);
      parts.push('<div class="table-wrap"><table>');
      parts.push(
        `<thead><tr>${panel.table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}${withLinks ? '<th>처리</th>' : ''}</tr></thead>`,
      );
      parts.push('<tbody>');
      panel.table.rows.forEach((row, index) => {
        const link = withLinks ? rowLinks?.[index] : undefined;
        const action = withLinks ? `<td>${link ? renderLink(link) : ''}</td>` : '';
        parts.push(`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}${action}</tr>`);
      });
      parts.push('</tbody></table></div>');
    }
  }
  if (panel.notes.length > 0) {
    parts.push(`<ul class="notes">${panel.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`);
  }
  const links = (panel.links ?? []).map(renderLink).filter((html) => html.length > 0);
  if (links.length > 0) parts.push(`<p class="links">${links.join(' ')}</p>`);
  parts.push('</section>');
  return parts.join('\n');
}

/** The dashboard. The CSRF token rides only in the sign-out form's hidden field. */
export function renderDashboard(
  view: OpsViewModel,
  csrfToken: string,
  refreshSeconds: number = OPS_UI_DEFAULT_REFRESH_SECONDS,
  handling = false,
): string {
  return page(
    'Quoky 운영 화면',
    ` data-page="dashboard" data-refresh-seconds="${escapeHtml(String(refreshSeconds))}"`,
    [
      '<header class="top">',
      '<div>',
      `<h1>Quoky 운영 화면${handling ? '' : ' (읽기 전용)'}</h1>`,
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

// ---------------------------------------------------------------------------------------------------------------
// OPS-2 handling pages (ADR-0113 D7). Every form is a same-origin POST with the session CSRF token; the executing
// forms also carry the one-time action nonce. No page shows a reply body, a payload or full memory content.
// ---------------------------------------------------------------------------------------------------------------

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function handlingPage(title: string, content: string[]): string {
  return page(title, ' data-page="action"', ['<main class="signin">', '<section class="panel">', ...content, '<p><a href="/">운영 화면으로</a></p>', '</section>', '</main>'].join('\n'));
}

/** The single explicit confirm step of a reminder cancel. */
export function renderReminderCancelConfirm(
  preview: Extract<OpsReminderCancelPreview, { status: 'FOUND' }>,
  csrfToken: string,
  nonce: string,
): string {
  return handlingPage('알림 취소', [
    `<h2>알림 #${escapeHtml(String(preview.displayNo))} 취소</h2>`,
    '<dl>',
    `<dt>내용 (알림 목록과 같음)</dt><dd>${escapeHtml(preview.label)}</dd>`,
    `<dt>다음 시각</dt><dd>${escapeHtml(preview.nextAt)}</dd>`,
    '</dl>',
    '<p>채팅의 "알림 N 취소"와 같은 처리예요. 취소하면 되돌릴 수 없어요.</p>',
    '<form method="post" action="/actions/reminders/cancel">',
    hidden('csrf', csrfToken),
    hidden('nonce', nonce),
    '<button type="submit">이 알림 취소</button>',
    '</form>',
  ]);
}

/** The owner's `기억 목록` previews, each with a forget request form (issuing the code is a POST). */
export function renderMemoryPage(list: OpsMemoryList, csrfToken: string): string {
  if (list.status === 'REFUSED') return renderActionOutcome('기억 잊기', list.outcome);
  const parts: string[] = ['<h2>기억 잊기</h2>'];
  if (list.rows.length === 0) {
    parts.push('<p class="empty">저장된 기억이 없어요.</p>');
  } else {
    parts.push('<div class="table-wrap"><table>', '<thead><tr><th>번호</th><th>미리보기 (기억 목록과 같음)</th><th>처리</th></tr></thead>', '<tbody>');
    for (const row of list.rows) {
      parts.push(
        [
          '<tr>',
          `<td>${escapeHtml(String(row.number))}</td>`,
          `<td>${escapeHtml(row.preview)}</td>`,
          '<td><form method="post" action="/actions/memories/forget/request">',
          hidden('csrf', csrfToken),
          hidden('number', String(row.number)),
          '<button type="submit">잊기…</button>',
          '</form></td>',
          '</tr>',
        ].join(''),
      );
    }
    parts.push('</tbody></table></div>');
    if (list.total > list.rows.length) parts.push(`<p class="empty">외 ${escapeHtml(String(list.total - list.rows.length))}건은 채팅의 "기억 목록 N"에서 보세요.</p>`);
  }
  parts.push('<p class="empty">잊기는 채팅과 같이 확인 코드를 한 번 더 입력해야 실행돼요.</p>');
  return handlingPage('기억 잊기', parts);
}

/** The forget confirmation: the chat preview and code, and a form where the owner types the code back. */
export function renderForgetConfirm(
  request: Extract<OpsForgetRequest, { status: 'CONFIRMATION' }>,
  csrfToken: string,
  nonce: string,
  wrongCode = false,
): string {
  return handlingPage('기억 잊기 확인', [
    `<h2>기억 ${escapeHtml(String(request.number))}번을 잊을까요?</h2>`,
    `<blockquote>${escapeHtml(request.preview)}</blockquote>`,
    `<p>맞으면 30분 안에 확인 코드 <code>${escapeHtml(request.code)}</code>를 입력하세요. 채팅의 "기억 확인 ${escapeHtml(request.code)}"와 같아요.</p>`,
    wrongCode ? '<p class="error">확인 코드가 맞지 않아요.</p>' : '',
    '<form method="post" action="/actions/memories/forget/confirm" autocomplete="off">',
    hidden('csrf', csrfToken),
    hidden('nonce', nonce),
    '<label for="code">확인 코드</label>',
    '<input id="code" name="code" type="text" required autocomplete="off" spellcheck="false" maxlength="8">',
    '<button type="submit">잊기 실행</button>',
    '</form>',
  ]);
}

/** The outcome of an action: fixed copy and its code only (never a reply body). `retry` is a same-origin link back. */
export function renderActionOutcome(title: string, outcome: OpsActionOutcome, repeated = false, retry?: OpsLink): string {
  return handlingPage(title, [
    `<h2>${escapeHtml(title)}</h2>`,
    `<p class="${outcome.ok ? 'state state-ok' : 'state state-unavailable'}">${escapeHtml(outcome.code)}</p>`,
    `<p>${escapeHtml(outcome.message)}</p>`,
    repeated ? '<p class="empty">이미 처리한 요청이라 다시 실행하지 않았어요.</p>' : '',
    retry ? `<p>${renderLink(retry)}</p>` : '',
  ]);
}

/**
 * A link back to the originating chat conversation (OPS-2b): only a Discord channel URL made of ids, opened in a new
 * tab without a referrer. Anything else renders nothing.
 */
export function isChatLink(href: string): boolean {
  return /^https:\/\/discord\.com\/channels\/(?:@me|[0-9]{1,20})\/[0-9]{1,20}$/.test(href);
}

/**
 * OPS-2b approve/reject confirmation (ADR-0113 D7): metadata only, plus the reference field. Approving needs the 6-character
 * code that chat shows in the approval preview's reference line (the UI never shows it); rejecting is a single explicit
 * confirm. Both are same-origin POSTs with the session CSRF token and a one-time nonce.
 */
export function renderApprovalConfirm(
  preview: Extract<OpsApprovalPreview, { status: 'FOUND' }>,
  csrfToken: string,
  nonces: { readonly approve?: string; readonly reject: string },
): string {
  const chat =
    preview.chatLink !== undefined && isChatLink(preview.chatLink)
      ? `<a class="action" href="${escapeHtml(preview.chatLink)}" target="_blank" rel="noopener noreferrer">채팅에서 열기</a>`
      : '';
  const parts: string[] = [
    `<h2>승인 요청 ${escapeHtml(preview.shortId)}</h2>`,
    '<dl>',
    `<dt>작업 종류</dt><dd>${escapeHtml(preview.kindLabel)}</dd>`,
    `<dt>위험도</dt><dd>${escapeHtml(preview.riskLevel)}</dd>`,
    `<dt>생성</dt><dd>${escapeHtml(preview.createdAt)}</dd>`,
    `<dt>만료</dt><dd>${escapeHtml(preview.expiresAt)}</dd>`,
    `<dt>채팅 위치</dt><dd>${escapeHtml(preview.chatPlace)} ${chat}</dd>`,
    '</dl>',
    '<p>내용(미리보기, diff, 대상, 본문)은 여기에 표시하지 않아요. 채팅의 승인 미리보기에서 확인하세요.</p>',
  ];
  if (preview.approvable && nonces.approve !== undefined) {
    parts.push(
      '<p>승인하려면 채팅 미리보기 끝의 "운영 화면 확인 코드" 줄에 있는 6자리 코드를 입력하세요. 승인은 기록만 하고, 실제 실행(커밋, 푸시, PR, 머지, 게시 등)은 지금처럼 채팅의 실행 문구로만 해요.</p>',
      '<form method="post" action="/actions/approvals/approve" autocomplete="off">',
      hidden('csrf', csrfToken),
      hidden('nonce', nonces.approve),
      '<label for="reference">운영 화면 확인 코드</label>',
      '<input id="reference" name="reference" type="text" required autocomplete="off" spellcheck="false" maxlength="12">',
      '<button type="submit">승인</button>',
      '</form>',
    );
  } else {
    parts.push('<p class="empty">이 승인은 승인하는 순간 작업이 이어서 실행돼서, 승인은 채팅에서만 할 수 있어요. 거절은 여기서도 돼요.</p>');
  }
  parts.push(
    '<form method="post" action="/actions/approvals/reject">',
    hidden('csrf', csrfToken),
    hidden('nonce', nonces.reject),
    '<button type="submit">거절</button>',
    '</form>',
  );
  return handlingPage('승인 처리', parts);
}
