// ─── Helpers ──────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtPhone = (waId) => `+${waId}`;
const fmtSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const plural = (n, word) => `${n.toLocaleString()} ${n === 1 ? word : word === 'person' ? 'people' : `${word}s`}`;

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
  toastTimer = setTimeout(() => (el.className = ''), 4500);
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, 'error');
  }
};

const formData = (form) => Object.fromEntries(new FormData(form).entries());

/** In-page confirmation; resolves true when the person confirms. */
function ask(text, yesLabel = 'Confirm') {
  const dialog = $('#ask-dialog');
  $('#ask-text').textContent = text;
  $('#ask-yes').textContent = yesLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

const TABS = ['lists', 'messages', 'auto', 'inbox', 'stats', 'settings', 'simulator'];
const loaders = {};

function showTab(name) {
  for (const btn of $$('[role=tab]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  for (const panel of $$('.tab-panel')) panel.hidden = panel.id !== `tab-${name}`;
  location.hash = name;
  loaders[name]?.();
  refreshHandoffCount();
}

for (const btn of $$('[role=tab]')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
for (const link of $$('[data-goto]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showTab(link.dataset.goto);
  });
}

const refreshHandoffCount = run(async () => {
  const open = (await api('/handoffs')).filter((h) => h.status === 'open').length;
  const badge = $('#handoff-count');
  badge.textContent = open;
  badge.hidden = open === 0;
  badge.title = `${plural(open, 'open call-back request')}`;
});

// ─── Files (attachments) ──────────────────────────────────────────────────

const KIND_ICON = { document: '📄', image: '🖼', video: '🎞' };
let mediaFiles = [];

async function loadMedia() {
  mediaFiles = await api('/media');
  for (const select of $$('[data-media-select]')) {
    const current = select.value;
    select.innerHTML =
      '<option value="">No attachment</option>' +
      mediaFiles.map((m) => `<option value="${m.id}">${KIND_ICON[m.kind]} ${esc(m.filename)}</option>`).join('');
    select.value = mediaFiles.some((m) => String(m.id) === current) ? current : '';
  }
  return mediaFiles;
}

const mediaName = (id) => mediaFiles.find((m) => m.id === id)?.filename ?? 'attachment';

async function uploadFile(file) {
  const res = await fetch(`/api/media?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

for (const input of $$('[data-media-upload]')) {
  input.addEventListener('change', run(async () => {
    const file = input.files?.[0];
    if (!file) return;
    const label = input.nextElementSibling;
    label.textContent = 'Uploading…';
    try {
      const saved = await uploadFile(file);
      await loadMedia();
      const select = input.closest('.attach')?.querySelector('[data-media-select]');
      if (select) select.value = String(saved.id);
      toast(`Uploaded ${saved.filename}`);
      if (!$('#tab-settings').hidden) renderMediaTable();
    } finally {
      input.value = '';
      label.textContent = 'Upload a file';
    }
  }));
}

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
    <div class="table-wrap"><table>
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
    </table></div>`;
  for (const btn of $$('[data-open-list]', el)) btn.addEventListener('click', run(() => openList(Number(btn.dataset.openList))));
}

/** Reads "phone, name" lines (pasted or from a CSV). Lines without digits, like a header row, are skipped. */
function parseContacts(text) {
  const contacts = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/\d/.test(line)) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const phoneIndex = cells.findIndex((c) => /^\+?[\d\s().-]{7,}$/.test(c));
    const phone = phoneIndex >= 0 ? cells[phoneIndex] : cells[0];
    const name = cells.filter((c, i) => i !== phoneIndex && c && !/\d{5,}/.test(c))[0] ?? '';
    contacts.push({ phone, name });
  }
  return contacts;
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
  const active = members.filter((m) => m.status === 'active').length;

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
      ${join.qr ? `<img src="${join.qr}" alt="QR code to join ${esc(list.name)}" width="160" height="160">` : ''}
      <div>
        <h3>Invite people</h3>
        <p>Share this link or QR code. Tapping it opens WhatsApp with <code>${esc(join.keyword)}</code> ready to send. People don't need your number saved.</p>
        <div class="copy-row">
          <input readonly value="${esc(join.link)}" id="join-link" aria-label="Join link">
          <button class="primary" id="copy-link">Copy link</button>
        </div>
        <p class="muted">Or tell people to message <strong>${esc(join.keyword)}</strong> to your WhatsApp number. They can reply <strong>STOP ${esc(list.slug)}</strong> to leave.</p>
      </div>
    </div>

    <details class="add-contacts"${members.length === 0 ? ' open' : ''}>
      <summary>Add contacts yourself</summary>
      <form id="contacts-form" class="form">
        <label for="contacts-text">Contacts
          <textarea id="contacts-text" name="contacts" rows="5" placeholder="+234 803 123 4567, Ada&#10;0805 987 6543, Tunde"></textarea>
          <small>One person per line: phone number, then name (optional). Paste from a spreadsheet, or upload a CSV.</small>
        </label>
        <label class="upload"><input type="file" id="contacts-file" accept=".csv,.txt,text/csv,text/plain"><span>Upload CSV</span></label>
        <label class="check"><input type="checkbox" name="consent" id="contacts-consent"> These people agreed to get WhatsApp messages from me</label>
        <p class="hint">Only add people who expect to hear from you, such as existing customers. People added here get templates only (no free text), and anyone who leaves with STOP can't be added back.</p>
        <button type="submit" class="primary">Add to list</button>
      </form>
    </details>

    <h3>Subscribers <span class="muted">(${active} active)</span></h3>
    ${
      members.length === 0
        ? '<p class="empty">Nobody is on this list yet.</p>'
        : `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>How</th><th>Since</th><th></th></tr></thead>
            <tbody>
              ${members
                .map(
                  (m) => `
                <tr>
                  <td>${esc(m.name) || '<span class="muted">—</span>'}</td>
                  <td class="nowrap">${esc(fmtPhone(m.waId))}</td>
                  <td><span class="pill ${m.status}">${m.status === 'active' ? 'active' : 'left'}</span></td>
                  <td class="muted">${m.source === 'manual' ? 'Added by you' : 'Joined on WhatsApp'}</td>
                  <td>${fmtDate(m.optedInAt)}</td>
                  <td class="actions">${m.status === 'active' ? `<button class="ghost danger" data-remove="${m.id}">Remove</button>` : ''}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table></div>`
    }`;

  $('#close-list').addEventListener('click', () => {
    openListId = null;
    detail.hidden = true;
    renderLists();
  });
  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(join.link);
      toast('Join link copied');
    } catch {
      $('#join-link').select();
      toast('Link selected. Press Ctrl+C or ⌘C to copy it.');
    }
  });
  $('#delete-list').addEventListener('click', run(async () => {
    if (!(await ask(`Delete "${list.name}"? Its subscribers and campaigns will be removed.`, 'Delete list'))) return;
    await api(`/lists/${list.id}`, { method: 'DELETE' });
    openListId = null;
    detail.hidden = true;
    toast('List deleted');
    await loaders.lists();
  }));
  $('#edit-list').addEventListener('click', () => editList(list));
  for (const btn of $$('[data-remove]', detail)) {
    btn.addEventListener('click', run(async () => {
      if (!(await ask('Remove this person from the list?', 'Remove'))) return;
      await api(`/lists/${list.id}/members/${btn.dataset.remove}`, { method: 'DELETE' });
      toast('Removed');
      await loaders.lists();
    }));
  }
  $('#contacts-file').addEventListener('change', run(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('That file is over 2 MB. Split it into smaller files.');
    const text = await file.text();
    const box = $('#contacts-text');
    box.value = [box.value.trim(), text.trim()].filter(Boolean).join('\n');
    toast(`Loaded ${plural(parseContacts(text).length, 'contact')} from ${file.name}`);
    e.target.value = '';
  }));
  $('#contacts-form').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const contacts = parseContacts($('#contacts-text').value);
    if (contacts.length === 0) throw new Error('Paste or upload at least one phone number');
    const consent = $('#contacts-consent').checked;
    const r = await api(`/lists/${list.id}/members`, { method: 'POST', body: { contacts, consent } });
    const parts = [`Added ${plural(r.added, 'person')}`];
    if (r.alreadyMember) parts.push(`${r.alreadyMember} already on the list`);
    if (r.optedOut.length) parts.push(`${r.optedOut.length} left earlier and weren't re-added`);
    if (r.invalid.length) parts.push(`${r.invalid.length} invalid (${r.invalid.slice(0, 3).join(', ')}${r.invalid.length > 3 ? '…' : ''})`);
    toast(parts.join(' · '), r.invalid.length && !r.added ? 'error' : 'ok');
    await loaders.lists();
  }));
}

function editList(list) {
  const dialog = $('#edit-dialog');
  $('#edit-name').value = list.name;
  $('#edit-welcome').value = list.welcomeMessage;
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener(
    'close',
    run(async () => {
      if (dialog.returnValue !== 'yes') return;
      await api(`/lists/${list.id}`, { method: 'PATCH', body: { name: $('#edit-name').value, welcomeMessage: $('#edit-welcome').value } });
      toast('Saved');
      await loaders.lists();
    }),
    { once: true },
  );
}

$('#list-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const created = await api('/lists', { method: 'POST', body: formData(e.target) });
  e.target.reset();
  delete $('#list-form [name=slug]').dataset.touched;
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

// ─── Campaigns ────────────────────────────────────────────────────────────

const STATUS_LABEL = { scheduled: 'Scheduled', sending: 'Sending…', sent: 'Sent', cancelled: 'Cancelled', failed: 'Failed' };

loaders.messages = run(async () => {
  const [freshLists, messages] = await Promise.all([api('/lists'), api('/messages'), loadMedia()]);
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
  const attachment = m.mediaId ? `<div class="attachment">📎 ${esc(mediaName(m.mediaId))}</div>` : '';
  if (m.kind === 'text') return esc(m.body) + attachment;
  const params = m.templateParams.map((p, i) => `<span class="muted">{{${i + 1}}}</span> ${esc(p)}`).join('<br>');
  return `<code>${esc(m.templateName)}</code> <span class="muted">${esc(m.templateLanguage)}</span>${params ? `<div class="params">${params}</div>` : ''}${attachment}`;
}

function renderMessages(messages) {
  const el = $('#messages-table');
  if (messages.length === 0) {
    el.innerHTML = '<p class="empty">No campaigns yet.</p>';
    return;
  }
  el.innerHTML = `
    <div class="table-wrap"><table>
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
                  `${c.read} opened`,
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
    </table></div>`;
  for (const btn of $$('[data-cancel]', el)) {
    btn.addEventListener('click', run(async () => {
      if (!(await ask('Cancel this scheduled campaign?', 'Cancel campaign'))) return;
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
      <h2>Campaign #${messageId}: recipients</h2>
      <button class="ghost" id="close-detail" aria-label="Close">✕</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Updated</th><th>Error</th></tr></thead>
      <tbody>
        ${deliveries
          .map(
            (d) => `
          <tr>
            <td>${esc(d.name) || '<span class="muted">—</span>'}</td>
            <td class="nowrap">${esc(fmtPhone(d.waId))}</td>
            <td><span class="pill ${d.status}">${d.status === 'read' ? 'opened' : d.status}</span></td>
            <td>${fmtDate(d.updatedAt)}</td>
            <td class="muted">${esc(d.error ?? '')}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
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
  const body = { listId: Number(f.listId), kind: f.kind, mediaId: f.mediaId ? Number(f.mediaId) : null };
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
  toast(f.when === 'later' ? `Scheduled for ${fmtDate(Date.parse(body.sendAt))}` : 'Queued. Sending within a few seconds.');
  await loaders.messages();
  if (f.when === 'now') setTimeout(loaders.messages, 3000);
}));

$('#refresh-messages').addEventListener('click', () => loaders.messages());

// ─── Auto-replies ─────────────────────────────────────────────────────────

let autoReplies = [];
const autoForm = $('#auto-form');

loaders.auto = run(async () => {
  [autoReplies] = await Promise.all([api('/auto-replies'), loadMedia()]);
  renderAutoReplies();
});

function syncAutoForm() {
  const { action } = formData(autoForm);
  for (const el of $$('[data-action]', autoForm)) el.hidden = el.dataset.action !== action;
}
autoForm.addEventListener('change', syncAutoForm);

function resetAutoForm() {
  autoForm.reset();
  autoForm.elements.id.value = '';
  $('#auto-form-title').textContent = 'New auto-reply';
  $('#auto-cancel').hidden = true;
  syncAutoForm();
}
$('#auto-cancel').addEventListener('click', resetAutoForm);

function renderAutoReplies() {
  const el = $('#auto-table');
  if (autoReplies.length === 0) {
    el.innerHTML = '<p class="empty">No auto-replies yet. Try <strong>ACCOUNT</strong> for bank details, or <strong>CALL ME</strong> to connect people to you.</p>';
    return;
  }
  el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Keyword</th><th>What happens</th><th class="num">Used</th><th>On</th><th></th></tr></thead>
      <tbody>
        ${autoReplies
          .map(
            (a) => `
          <tr class="${a.enabled ? '' : 'off'}">
            <td><strong class="kw">${esc(a.keyword)}</strong></td>
            <td class="preview">
              ${a.action === 'handoff' ? '<span class="pill handoff">Connects them to you</span>' : ''}
              ${a.replyText ? `<div class="clamp">${esc(a.replyText)}</div>` : ''}
              ${a.mediaId ? `<div class="attachment">📎 ${esc(mediaName(a.mediaId))}</div>` : ''}
            </td>
            <td class="num">${a.hitCount.toLocaleString()}<div class="muted small">${a.lastHitAt ? fmtDate(a.lastHitAt) : 'never'}</div></td>
            <td><input type="checkbox" data-toggle="${a.id}" ${a.enabled ? 'checked' : ''} aria-label="Turn ${esc(a.keyword)} on or off"></td>
            <td class="actions"><button class="ghost" data-edit-auto="${a.id}">Edit</button> <button class="ghost danger" data-delete-auto="${a.id}">Delete</button></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
  for (const box of $$('[data-toggle]', el)) {
    box.addEventListener('change', run(async () => {
      await api(`/auto-replies/${box.dataset.toggle}`, { method: 'PATCH', body: { enabled: box.checked } });
      toast(box.checked ? 'Turned on' : 'Turned off');
      await loaders.auto();
    }));
  }
  for (const btn of $$('[data-edit-auto]', el)) {
    btn.addEventListener('click', () => {
      const a = autoReplies.find((x) => x.id === Number(btn.dataset.editAuto));
      autoForm.elements.id.value = a.id;
      autoForm.elements.keyword.value = a.keyword;
      autoForm.elements.action.value = a.action;
      autoForm.elements.replyText.value = a.replyText;
      autoForm.elements.mediaId.value = a.mediaId ?? '';
      autoForm.elements.enabled.checked = a.enabled;
      $('#auto-form-title').textContent = `Edit ${a.keyword}`;
      $('#auto-cancel').hidden = false;
      syncAutoForm();
      autoForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  for (const btn of $$('[data-delete-auto]', el)) {
    btn.addEventListener('click', run(async () => {
      if (!(await ask('Delete this auto-reply?', 'Delete'))) return;
      await api(`/auto-replies/${btn.dataset.deleteAuto}`, { method: 'DELETE' });
      toast('Deleted');
      await loaders.auto();
    }));
  }
}

autoForm.addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const f = formData(autoForm);
  const body = {
    keyword: f.keyword,
    action: f.action,
    replyText: f.replyText,
    mediaId: f.mediaId ? Number(f.mediaId) : null,
    enabled: autoForm.elements.enabled.checked,
  };
  if (f.id) await api(`/auto-replies/${f.id}`, { method: 'PATCH', body });
  else await api('/auto-replies', { method: 'POST', body });
  toast(f.id ? 'Saved' : `Auto-reply for ${f.keyword.toUpperCase()} is ready`);
  resetAutoForm();
  await loaders.auto();
}));

// ─── Inbox & call-back requests ───────────────────────────────────────────

const ALERT_LABEL = {
  sent: ['sent', 'Alert sent'],
  failed: ['failed', 'Alert failed'],
  not_configured: ['pending', 'No alert: add your number in Settings'],
};

function handledLabel(h) {
  if (!h) return '';
  if (h === 'talk-to-me') return '<span class="pill handoff">wants to talk</span>';
  if (h.startsWith('keyword:')) return `<span class="pill accepted">auto-reply ${esc(h.slice(8))}</span>`;
  if (h.startsWith('join:')) return `<span class="pill active">joined ${esc(h.slice(5))}</span>`;
  if (h.startsWith('leave:')) return `<span class="pill">left ${h === 'leave:all' ? 'all lists' : esc(h.slice(6))}</span>`;
  return `<span class="pill">${esc(h)}</span>`;
}

loaders.inbox = run(async () => {
  const [items, handoffs] = await Promise.all([api('/inbox'), api('/handoffs')]);
  const open = handoffs.filter((h) => h.status === 'open');

  $('#handoffs-table').innerHTML = handoffs.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Asked</th><th>Who</th><th>They said</th><th>Your alert</th><th></th></tr></thead>
        <tbody>
          ${handoffs
            .map((h) => {
              const [cls, label] = ALERT_LABEL[h.notifyStatus];
              return `
            <tr class="${h.status === 'done' ? 'off' : ''}">
              <td>${fmtDate(h.createdAt)}</td>
              <td><strong>${esc(h.name) || 'Unknown'}</strong><div class="muted nowrap">${esc(fmtPhone(h.waId))}</div></td>
              <td class="preview">${esc(h.message)}</td>
              <td><span class="pill ${cls}" title="${esc(h.notifyError ?? '')}">${label}</span>${h.notifyError && h.notifyStatus === 'failed' ? `<div class="muted small">${esc(h.notifyError)}</div>` : ''}</td>
              <td class="actions">
                ${h.status === 'open'
                  ? `<a class="button ghost" href="https://wa.me/${esc(h.waId)}" target="_blank" rel="noopener">Chat</a>
                     <button class="ghost" data-done="${h.id}">Mark done</button>`
                  : `<span class="muted">Done ${fmtDate(h.resolvedAt)}</span>`}
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table></div>`
    : '<p class="empty">No requests yet. Create a “Connect them to me” auto-reply, e.g. <strong>CALL ME</strong>, and people can ask to talk to you.</p>';
  for (const btn of $$('[data-done]')) {
    btn.addEventListener('click', run(async () => {
      await api(`/handoffs/${btn.dataset.done}/done`, { method: 'POST' });
      toast('Marked as done');
      await loaders.inbox();
      refreshHandoffCount();
    }));
  }
  if (open.length === 0 && handoffs.length) $('#handoffs-table').insertAdjacentHTML('afterbegin', '<p class="hint">All caught up.</p>');

  $('#inbox-table').innerHTML = items.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>From</th><th>Message</th><th>Handled as</th></tr></thead>
        <tbody>
          ${items
            .map(
              (i) => `
            <tr>
              <td>${fmtDate(i.receivedAt)}</td>
              <td>${esc(i.name) || ''} <span class="muted nowrap">${esc(fmtPhone(i.waId))}</span></td>
              <td class="preview">${i.text ? esc(i.text) : `<span class="muted">[${esc(i.type)}]</span>`}</td>
              <td>${handledLabel(i.handledAs)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`
    : '<p class="empty">No messages received yet.</p>';
});
$('#refresh-inbox').addEventListener('click', () => loaders.inbox());

// ─── Stats ────────────────────────────────────────────────────────────────

let lastStats = null;
loaders.stats = run(async () => {
  const days = $('#stats-days').value;
  lastStats = await api(`/stats?days=${days}&tzOffset=${new Date().getTimezoneOffset()}`);
  renderStats(lastStats);
});
// The chart is drawn at its real pixel width so text stays readable; redraw when that changes.
addEventListener('resize', () => {
  const box = $('#stats-chart');
  if (lastStats && !$('#tab-stats').hidden && Math.abs(box.clientWidth - Number(box.dataset.width)) > 40) renderStats(lastStats);
});
$('#stats-days').addEventListener('change', () => loaders.stats());

function kpi(label, value, sub) {
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

function meter(n, d) {
  const share = d ? n / d : 0;
  return `<div class="meter" title="${n} of ${d}"><span style="width:${(share * 100).toFixed(1)}%"></span></div><span class="meter-value">${pct(n, d)}</span>`;
}

function renderStats({ totals: t, daily, campaigns, autoReplies: autos }) {
  const net = t.joined - t.left;
  $('#stats-kpis').innerHTML = [
    kpi('Subscribers', t.activeSubscribers.toLocaleString(), `${net >= 0 ? '+' : '−'}${Math.abs(net)} this period (${t.joined} joined, ${t.left} left)`),
    kpi('Campaigns sent', t.campaigns.toLocaleString(), `${plural(t.sent, 'message')} sent`),
    kpi('Delivered', pct(t.delivered, t.sent), `${t.delivered.toLocaleString()} of ${t.sent.toLocaleString()} reached a phone`),
    kpi('Opened', pct(t.read, t.delivered), `${t.read.toLocaleString()} of ${t.delivered.toLocaleString()} delivered were read`),
    kpi('Replied', pct(t.replied, t.sent), `${plural(t.replied, 'person')} messaged back`),
  ].join('');

  const chartBox = $('#stats-chart');
  chartBox.innerHTML = joinsChart(daily, Math.max(300, chartBox.clientWidth || 720));
  chartBox.dataset.width = chartBox.clientWidth;
  wireChartHover($('#stats-chart'), daily);

  $('#stats-campaigns').innerHTML = campaigns.length
    ? `<div class="table-wrap"><table class="perf">
        <thead><tr><th>Sent</th><th>Campaign</th><th class="num">Recipients</th><th>Delivered</th><th>Opened</th><th>Replied</th><th class="num">Failed</th></tr></thead>
        <tbody>
          ${campaigns
            .map(
              (c) => `
            <tr>
              <td>${fmtDate(c.sendAt)}</td>
              <td><strong>${esc(c.listName)}</strong><div class="muted">${c.kind === 'template' ? `<code>${esc(c.label)}</code>` : esc(c.label)}</div></td>
              <td class="num">${c.recipients.toLocaleString()}${c.skipped ? `<div class="muted small">${c.skipped} skipped</div>` : ''}</td>
              <td>${meter(c.delivered, c.sent)}</td>
              <td>${meter(c.read, c.delivered)}</td>
              <td>${meter(c.replied, c.sent)}</td>
              <td class="num ${c.failed ? 'bad' : ''}">${c.failed}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`
    : '<p class="empty">No campaigns sent in this period.</p>';

  $('#stats-auto').innerHTML = autos.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Keyword</th><th>Type</th><th class="num">Times used</th><th>Last used</th></tr></thead>
        <tbody>
          ${[...autos]
            .sort((a, b) => b.hitCount - a.hitCount)
            .map(
              (a) => `
            <tr>
              <td><strong class="kw">${esc(a.keyword)}</strong></td>
              <td>${a.action === 'handoff' ? 'Connects to you' : 'Reply'}</td>
              <td class="num">${a.hitCount.toLocaleString()}</td>
              <td>${a.lastHitAt ? fmtDate(a.lastHitAt) : '<span class="muted">never</span>'}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`
    : '<p class="empty">No auto-replies yet.</p>';
}

/** Rounds up to 1, 2 or 5 × a power of ten so axis labels are friendly. */
function niceMax(n) {
  if (n <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= n);
}

/** Bar with rounded corners on the end away from the zero line. */
function barPath(x, y, w, h, roundTop) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return roundTop
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

/** Joins above the line, leaves below, one bar pair per day, on one shared scale. */
function joinsChart(daily, W) {
  const H = 220, L = 36, R = 8, T = 14, B = 26;
  const up = niceMax(Math.max(0, ...daily.map((d) => d.joined)));
  const down = niceMax(Math.max(0, ...daily.map((d) => d.left)));
  const unit = (H - T - B) / (up + down);
  const zero = T + up * unit;
  const slot = (W - L - R) / daily.length;
  const bw = Math.max(2, Math.min(18, slot - 2));
  const xOf = (i) => L + i * slot + (slot - bw) / 2;
  const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor(W / 110)));
  const totalJoined = daily.reduce((n, d) => n + d.joined, 0);
  const totalLeft = daily.reduce((n, d) => n + d.left, 0);

  const bars = daily
    .map((d, i) => {
      const x = xOf(i);
      return `<path class="bar-up" d="${barPath(x, zero - d.joined * unit, bw, d.joined * unit, true)}"/>` +
        `<path class="bar-down" d="${barPath(x, zero + 1, bw, d.left * unit, false)}"/>`;
    })
    .join('');
  const xLabels = daily
    .map((d, i) => (i % labelEvery === 0 || i === daily.length - 1) && (i === daily.length - 1 || daily.length - 1 - i >= labelEvery / 2)
      ? `<text class="axis" x="${xOf(i) + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtDay(d.date))}</text>`
      : '')
    .join('');

  return `
    <div class="legend">
      <span><i class="sw up"></i>Joined <strong>${totalJoined}</strong></span>
      <span><i class="sw down"></i>Left <strong>${totalLeft}</strong></span>
    </div>
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily joins and leaves: ${totalJoined} joined and ${totalLeft} left in ${daily.length} days">
        <line class="grid" x1="${L}" x2="${W - R}" y1="${T}" y2="${T}"/>
        <line class="grid" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
        <text class="axis" x="${L - 6}" y="${T + 4}" text-anchor="end">${up}</text>
        <text class="axis" x="${L - 6}" y="${zero + 4}" text-anchor="end">0</text>
        <text class="axis" x="${L - 6}" y="${H - B + 4}" text-anchor="end">${down}</text>
        ${bars}
        <line class="zero" x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}"/>
        ${xLabels}
        <rect class="hover-col" y="${T}" height="${H - T - B}" width="${slot}" x="-999"/>
      </svg>
      <div class="tip" hidden></div>
    </div>
    <details class="table-view">
      <summary>Show as table</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Day</th><th class="num">Joined</th><th class="num">Left</th></tr></thead>
        <tbody>${daily.map((d) => `<tr><td>${esc(fmtDay(d.date))}</td><td class="num">${d.joined}</td><td class="num">${d.left}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`;
}

function wireChartHover(root, daily) {
  const svg = $('svg', root);
  const tip = $('.tip', root);
  const col = $('.hover-col', root);
  if (!svg) return;
  const { width: W } = svg.viewBox.baseVal;
  const L = 36, R = 8;
  const slot = (W - L - R) / daily.length;
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor((x - L) / slot);
    if (i < 0 || i >= daily.length) {
      tip.hidden = true;
      col.setAttribute('x', -999);
      return;
    }
    const d = daily[i];
    col.setAttribute('x', L + i * slot);
    tip.innerHTML = `<strong>${esc(fmtDay(d.date))}</strong><span><i class="sw up"></i>${d.joined} joined</span><span><i class="sw down"></i>${d.left} left</span>`;
    tip.hidden = false;
    const px = ((L + (i + 0.5) * slot) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(px, 70), box.width - 70)}px`;
  });
  svg.addEventListener('pointerleave', () => {
    tip.hidden = true;
    col.setAttribute('x', -999);
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────

const settingsForm = $('#settings-form');

loaders.settings = run(async () => {
  const [settings] = await Promise.all([api('/settings'), loadMedia()]);
  for (const [key, value] of Object.entries(settings)) {
    if (settingsForm.elements[key]) settingsForm.elements[key].value = key === 'ownerPhone' && value ? `+${value}` : value;
  }
  renderMediaTable();
});

settingsForm.addEventListener('submit', run(async (e) => {
  e.preventDefault();
  await api('/settings', { method: 'PUT', body: formData(settingsForm) });
  toast('Settings saved');
  await loaders.settings();
}));

function renderMediaTable() {
  const el = $('#media-table');
  el.innerHTML = mediaFiles.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>File</th><th class="num">Size</th><th>In use</th><th></th></tr></thead>
        <tbody>
          ${mediaFiles
            .map(
              (m) => `
            <tr>
              <td>${KIND_ICON[m.kind]} <a href="/api/media/${m.id}/file" target="_blank" rel="noopener">${esc(m.filename)}</a><div class="muted small">${fmtDate(m.createdAt)}</div></td>
              <td class="num">${fmtSize(m.size)}</td>
              <td>${m.usedBy ? `<span class="pill accepted">${m.usedBy} in use</span>` : '<span class="muted">no</span>'}</td>
              <td class="actions">${m.usedBy ? '' : `<button class="ghost danger" data-delete-media="${m.id}">Delete</button>`}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`
    : '<p class="empty">No files yet. Upload a price list, quotation template or brochure to attach it to campaigns and auto-replies.</p>';
  for (const btn of $$('[data-delete-media]', el)) {
    btn.addEventListener('click', run(async () => {
      if (!(await ask('Delete this file?', 'Delete'))) return;
      await api(`/media/${btn.dataset.deleteMedia}`, { method: 'DELETE' });
      toast('File deleted');
      await loadMedia();
      renderMediaTable();
    }));
  }
}

// ─── Simulator ────────────────────────────────────────────────────────────

loaders.simulator = run(async () => {
  const [outbox, freshLists, autos] = await Promise.all([api('/simulate/outbox'), api('/lists'), api('/auto-replies')]);
  lists = freshLists;
  const chips = [
    ...lists.flatMap((l) => [`JOIN ${l.slug}`, `STOP ${l.slug}`]),
    ...autos.filter((a) => a.enabled).map((a) => a.keyword),
    'LISTS',
    'STOP',
    'HELP',
  ];
  $('#sim-chips').innerHTML = chips.map((t) => `<button type="button" class="chip" data-text="${esc(t)}">${esc(t)}</button>`).join('');
  for (const chip of $$('.chip')) chip.addEventListener('click', () => ($('#sim-form [name=text]').value = chip.dataset.text));
  $('#outbox').innerHTML = outbox.length
    ? outbox
        .map(
          (o) => `
        <div class="bubble">
          <div class="bubble-meta">to ${esc(fmtPhone(o.to))} · ${o.kind} · ${fmtDate(o.at)}</div>
          ${o.attachment ? `<div class="attachment">${KIND_ICON[o.attachment.kind]} ${esc(o.attachment.filename)}</div>` : ''}
          ${o.text ? `<div class="bubble-text">${esc(o.text)}</div>` : ''}
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
  await loadMedia();
  showTab(TABS.includes(initial) && (initial !== 'simulator' || config.mode === 'mock') ? initial : 'lists');
})();
syncMessageForm();
syncAutoForm();
