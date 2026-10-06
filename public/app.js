// ─── Helpers ──────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtPhone = (waId) => `+${waId}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, 'error');
  }
};

const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ─── Tabs ─────────────────────────────────────────────────────────────────

const loaders = {};

function showTab(name) {
  for (const btn of $$('[role=tab]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  for (const panel of $$('.tab-panel')) panel.hidden = panel.id !== `tab-${name}`;
  location.hash = name;
  loaders[name]?.();
}

for (const btn of $$('[role=tab]')) btn.addEventListener('click', () => showTab(btn.dataset.tab));

// ─── Lists ────────────────────────────────────────────────────────────────

let lists = [];
let openListId = null;

loaders.lists = run(async () => {
  lists = await api('/lists');
  renderLists();
  if (openListId) await openList(openListId);
});

function renderLists() {
  const el = $('#lists-table');
  if (lists.length === 0) {
    el.innerHTML = '<p class="empty">No lists yet. Create one to get a join link.</p>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Keyword</th><th class="num">Subscribers</th><th></th></tr></thead>
      <tbody>
        ${lists
          .map(
            (l) => `
          <tr class="${l.id === openListId ? 'selected' : ''}">
            <td><strong>${esc(l.name)}</strong>${l.description ? `<div class="muted">${esc(l.description)}</div>` : ''}</td>
            <td><code>${esc(l.slug)}</code></td>
            <td class="num">${l.activeCount}${l.unsubscribedCount ? ` <span class="muted">(${l.unsubscribedCount} left)</span>` : ''}</td>
            <td class="actions"><button class="ghost" data-open-list="${l.id}">Open</button></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  for (const btn of $$('[data-open-list]', el)) btn.addEventListener('click', run(() => openList(Number(btn.dataset.openList))));
}

async function openList(listId) {
  const list = lists.find((l) => l.id === listId);
  const detail = $('#list-detail');
  if (!list) {
    openListId = null;
    detail.hidden = true;
    return;
  }
  openListId = listId;
  renderLists();
  const [join, members] = await Promise.all([api(`/lists/${listId}/join`), api(`/lists/${listId}/members`)]);

  detail.hidden = false;
  detail.innerHTML = `
    <div class="card-head">
      <h2>${esc(list.name)}</h2>
      <div class="row">
        <button class="ghost" id="edit-list">Edit</button>
        <button class="danger ghost" id="delete-list">Delete</button>
        <button class="ghost" id="close-list" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="join">
      <img src="${join.qr}" alt="QR code to join ${esc(list.name)}" width="160" height="160">
      <div>
        <h3>Invite people</h3>
        <p>Share this link or QR code. Tapping it opens WhatsApp with <code>${esc(join.keyword)}</code> ready to send — your number doesn't need to be saved.</p>
        <div class="copy-row">
          <input readonly value="${esc(join.link)}" id="join-link">
          <button class="primary" id="copy-link">Copy link</button>
        </div>
        <p class="muted">Or tell people to message <strong>${esc(join.keyword)}</strong> to your WhatsApp number. They can reply <strong>STOP ${esc(list.slug)}</strong> to leave.</p>
      </div>
    </div>
    <h3>Subscribers <span class="muted">(${members.filter((m) => m.status === 'active').length} active)</span></h3>
    ${
      members.length === 0
        ? '<p class="empty">Nobody has joined yet.</p>'
        : `<table>
            <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Joined</th><th></th></tr></thead>
            <tbody>
              ${members
                .map(
                  (m) => `
                <tr>
                  <td>${esc(m.name) || '<span class="muted">—</span>'}</td>
                  <td>${esc(fmtPhone(m.waId))}</td>
                  <td><span class="pill ${m.status}">${m.status === 'active' ? 'active' : 'left'}</span></td>
                  <td>${fmtDate(m.optedInAt)}</td>
                  <td class="actions">${m.status === 'active' ? `<button class="ghost danger" data-remove="${m.id}">Remove</button>` : ''}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
    }`;

  $('#close-list').addEventListener('click', () => {
    openListId = null;
    detail.hidden = true;
    renderLists();
  });
  $('#copy-link').addEventListener('click', run(async () => {
    await navigator.clipboard.writeText(join.link);
    toast('Join link copied');
  }));
  $('#delete-list').addEventListener('click', run(async () => {
    if (!confirm(`Delete "${list.name}"? Its subscribers and messages will be removed.`)) return;
    await api(`/lists/${list.id}`, { method: 'DELETE' });
    openListId = null;
    detail.hidden = true;
    toast('List deleted');
    await loaders.lists();
  }));
  $('#edit-list').addEventListener('click', () => editList(list));
  for (const btn of $$('[data-remove]', detail)) {
    btn.addEventListener('click', run(async () => {
      if (!confirm('Remove this person from the list?')) return;
      await api(`/lists/${list.id}/members/${btn.dataset.remove}`, { method: 'DELETE' });
      toast('Removed');
      await loaders.lists();
    }));
  }
}

function editList(list) {
  const name = prompt('List name', list.name);
  if (name === null) return;
  const welcomeMessage = prompt('Welcome message (sent when someone joins)', list.welcomeMessage);
  if (welcomeMessage === null) return;
  run(async () => {
    await api(`/lists/${list.id}`, { method: 'PATCH', body: { name, welcomeMessage } });
    toast('Saved');
    await loaders.lists();
  })();
}

$('#list-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const created = await api('/lists', { method: 'POST', body: formData(e.target) });
  e.target.reset();
  toast(`Created "${created.name}"`);
  openListId = created.id;
  await loaders.lists();
}));

// Suggest a keyword from the name.
$('#list-form [name=name]').addEventListener('input', (e) => {
  const slug = $('#list-form [name=slug]');
  if (slug.dataset.touched) return;
  slug.value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
});
$('#list-form [name=slug]').addEventListener('input', (e) => (e.target.dataset.touched = '1'));

// ─── Messages ─────────────────────────────────────────────────────────────

const STATUS_LABEL = { scheduled: 'Scheduled', sending: 'Sending…', sent: 'Sent', cancelled: 'Cancelled', failed: 'Failed' };

loaders.messages = run(async () => {
  const [freshLists, messages] = await Promise.all([api('/lists'), api('/messages')]);
  lists = freshLists;
  const select = $('#message-form [name=listId]');
  const current = select.value;
  select.innerHTML = lists.length
    ? lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.activeCount})</option>`).join('')
    : '<option value="">Create a list first</option>';
  if (current) select.value = current;
  renderMessages(messages);
});

function messagePreview(m) {
  if (m.kind === 'text') return esc(m.body);
  const params = m.templateParams.map((p, i) => `<span class="muted">{{${i + 1}}}</span> ${esc(p)}`).join('<br>');
  return `<code>${esc(m.templateName)}</code> <span class="muted">${esc(m.templateLanguage)}</span>${params ? `<div class="params">${params}</div>` : ''}`;
}

function renderMessages(messages) {
  const el = $('#messages-table');
  if (messages.length === 0) {
    el.innerHTML = '<p class="empty">No messages yet.</p>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>When</th><th>List</th><th>Message</th><th>Status</th><th class="num">Results</th><th></th></tr></thead>
      <tbody>
        ${messages
          .map((m) => {
            const c = m.counts;
            const sent = c.accepted + c.sent + c.delivered + c.read;
            const stats = c.total
              ? [
                  `${sent}/${c.total} sent`,
                  `${c.delivered + c.read} delivered`,
                  `${c.read} read`,
                  c.failed && `<span class="bad">${c.failed} failed</span>`,
                  c.skipped && `${c.skipped} skipped`,
                ].filter(Boolean).join('<br>')
              : '—';
            return `
          <tr>
            <td>${fmtDate(m.sendAt)}</td>
            <td>${esc(m.listName)}</td>
            <td class="preview">${messagePreview(m)}</td>
            <td><span class="pill ${m.status}">${STATUS_LABEL[m.status]}</span></td>
            <td class="num">${stats}</td>
            <td class="actions">
              ${m.status === 'scheduled' ? `<button class="ghost danger" data-cancel="${m.id}">Cancel</button>` : ''}
              ${c.total ? `<button class="ghost" data-details="${m.id}">Details</button>` : ''}
            </td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
  for (const btn of $$('[data-cancel]', el)) {
    btn.addEventListener('click', run(async () => {
      if (!confirm('Cancel this scheduled message?')) return;
      await api(`/messages/${btn.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Cancelled');
      await loaders.messages();
    }));
  }
  for (const btn of $$('[data-details]', el)) btn.addEventListener('click', run(() => showDeliveries(Number(btn.dataset.details))));
}

async function showDeliveries(messageId) {
  const deliveries = await api(`/messages/${messageId}/deliveries`);
  const el = $('#message-detail');
  el.hidden = false;
  el.innerHTML = `
    <div class="card-head">
      <h2>Message #${messageId} — recipients</h2>
      <button class="ghost" id="close-detail" aria-label="Close">✕</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Updated</th><th>Error</th></tr></thead>
      <tbody>
        ${deliveries
          .map(
            (d) => `
          <tr>
            <td>${esc(d.name) || '<span class="muted">—</span>'}</td>
            <td>${esc(fmtPhone(d.waId))}</td>
            <td><span class="pill ${d.status}">${d.status}</span></td>
            <td>${fmtDate(d.updatedAt)}</td>
            <td class="muted">${esc(d.error ?? '')}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  $('#close-detail').addEventListener('click', () => (el.hidden = true));
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const messageForm = $('#message-form');

function syncMessageForm() {
  const { kind, when } = formData(messageForm);
  for (const el of $$('[data-kind]', messageForm)) el.hidden = el.dataset.kind !== kind;
  for (const el of $$('[data-when]', messageForm)) el.hidden = el.dataset.when !== when;
}
messageForm.addEventListener('change', syncMessageForm);
$('#tz-label').textContent = `(${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

messageForm.addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const f = formData(messageForm);
  const body = { listId: Number(f.listId), kind: f.kind };
  if (f.kind === 'template') {
    body.templateName = f.templateName.trim();
    body.templateLanguage = f.templateLanguage.trim();
    body.templateParams = f.templateParams.split('\n').map((p) => p.trim()).filter(Boolean);
  } else {
    body.body = f.body;
  }
  if (f.when === 'later') {
    if (!f.sendAt) throw new Error('Pick a date and time');
    const at = new Date(f.sendAt);
    if (at.getTime() < Date.now()) throw new Error('That time is in the past');
    body.sendAt = at.toISOString();
  }
  await api('/messages', { method: 'POST', body });
  toast(f.when === 'later' ? `Scheduled for ${fmtDate(Date.parse(body.sendAt))}` : 'Queued — sending within a few seconds');
  await loaders.messages();
  if (f.when === 'now') setTimeout(loaders.messages, 3000);
}));

$('#refresh-messages').addEventListener('click', () => loaders.messages());

// ─── Inbox ────────────────────────────────────────────────────────────────

loaders.inbox = run(async () => {
  const items = await api('/inbox');
  $('#inbox-table').innerHTML = items.length
    ? `<table>
        <thead><tr><th>Received</th><th>From</th><th>Message</th></tr></thead>
        <tbody>
          ${items
            .map(
              (i) => `
            <tr>
              <td>${fmtDate(i.receivedAt)}</td>
              <td>${esc(i.name) || ''} <span class="muted">${esc(fmtPhone(i.waId))}</span></td>
              <td>${i.text ? esc(i.text) : `<span class="muted">[${esc(i.type)}]</span>`}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
    : '<p class="empty">No messages received yet.</p>';
});
$('#refresh-inbox').addEventListener('click', () => loaders.inbox());

// ─── Simulator ────────────────────────────────────────────────────────────

loaders.simulator = run(async () => {
  const [outbox, freshLists] = await Promise.all([api('/simulate/outbox'), api('/lists')]);
  lists = freshLists;
  $('#sim-chips').innerHTML = [...lists.flatMap((l) => [`JOIN ${l.slug}`, `STOP ${l.slug}`]), 'LISTS', 'STOP', 'HELP']
    .map((t) => `<button type="button" class="chip" data-text="${esc(t)}">${esc(t)}</button>`)
    .join('');
  for (const chip of $$('.chip')) chip.addEventListener('click', () => ($('#sim-form [name=text]').value = chip.dataset.text));
  $('#outbox').innerHTML = outbox.length
    ? outbox
        .map(
          (o) => `
        <div class="bubble">
          <div class="bubble-meta">to ${esc(fmtPhone(o.to))} · ${o.kind} · ${fmtDate(o.at)}</div>
          <div class="bubble-text">${esc(o.text)}</div>
        </div>`,
        )
        .join('')
    : '<p class="empty">Nothing sent yet.</p>';
});

$('#sim-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  await api('/simulate/inbound', { method: 'POST', body: formData(e.target) });
  $('#sim-form [name=text]').value = '';
  await loaders.simulator();
}));
$('#refresh-outbox').addEventListener('click', () => loaders.simulator());

// ─── Boot ─────────────────────────────────────────────────────────────────

run(async () => {
  const config = await api('/config');
  const badge = $('#mode-badge');
  badge.textContent = config.mode === 'mock' ? 'Mock mode' : 'Live';
  badge.classList.add(config.mode);
  $('[data-tab=simulator]').hidden = config.mode !== 'mock';
  const initial = location.hash.slice(1);
  showTab(['lists', 'messages', 'inbox', 'simulator'].includes(initial) && (initial !== 'simulator' || config.mode === 'mock') ? initial : 'lists');
})();
syncMessageForm();
