/**
 * assets.js — the list, the form, and the record.
 *
 * The record view is the point of the whole application: what a thing is,
 * followed by everything that has happened to it. Everything else here exists
 * to get people to that page and keep it accurate.
 */

import { el, mount, facts, ago } from './dom.js';
import * as store from './store.js';
import { buildPut, buildCorrection } from './oplog.js';
import { template, templatesByCategory, toMetadata, readMetadata } from './templates.js';
import { splitRevisions } from './merge.js';
import { resolveVendor, servicerOf, setServicer } from './vendors.js';
import { context, writeOps } from './actions.js';

const go = hash => { location.hash = hash; };

// ── List ────────────────────────────────────────────────────────────────────

export async function renderAssets(root) {
  const assets = await store.list('asset');

  if (!assets.length) {
    mount(root, el('div.column', {},
      el('div.empty', {},
        el('h2', {}, 'Start with one thing you look after'),
        el('p', {},
          'A furnace, a roof, a truck, a well pump. Residuum keeps what it is, ' +
          'what has been done to it, and what that cost — for as long as you own it.'),
        el('div.actions', {},
          el('button', { onclick: () => go('#new') }, 'Add the first one')))));
    return;
  }

  assets.sort((a, b) => a.name.localeCompare(b.name));

  mount(root, el('div.column', {},
    el('section', {},
      el('div.row-between', {},
        el('h2', {}, `${assets.length} thing${assets.length === 1 ? '' : 's'}`),
        el('button', { onclick: () => go('#new') }, 'Add')),
      el('ul.records', {}, await Promise.all(assets.map(row))))));
}

async function row(asset) {
  const t = template(asset.template);
  const events = await store.list('event', { index: 'asset_id', value: asset.asset_id });
  const latest = events
    .filter(e => !e.superseded_by)
    .sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)))[0];

  return el('li.record', {},
    el('a', { href: `#asset/${asset.asset_id}` },
      el('span.record-icon', {}, t.icon || '◻'),
      el('span.record-body', {},
        el('span.record-name', {}, asset.name),
        el('span.record-meta', {},
          [t.name, asset.room, asset.manufacturer].filter(Boolean).join(', ') || 'No details yet')),
      el('span.record-aside', {},
        latest ? `${latest.type}, ${latest.occurred_on}` : 'Nothing recorded')));
}

// ── Form ────────────────────────────────────────────────────────────────────

export async function renderAssetForm(root, assetId = null) {
  const existing = assetId ? await store.get('asset', assetId) : null;
  let slug = existing?.template || 'hvac';

  const servicer = assetId ? await servicerOf(assetId) : null;
  const knownVendors = await store.list('vendor');

  const body = el('div');
  const draw = () => mount(body, fields());
  const note = el('p.note', { hidden: true });

  const picker = el('select', {
    id: 'template',
    onchange: e => { slug = e.target.value; draw(); },
  });
  for (const [category, items] of templatesByCategory()) {
    const group = el('optgroup', { label: category });
    for (const t of items) {
      group.append(el('option', { value: t.slug, selected: t.slug === slug }, t.name));
    }
    picker.append(group);
  }

  function fields() {
    const t = template(slug);
    const md = existing?.metadata || {};
    const val = key => {
      const entry = md[key];
      return entry && typeof entry === 'object' ? entry.v : (entry ?? '');
    };

    return el('div', {},
      textField('name', 'Name', existing?.name, { required: true, placeholder: 'Upstairs furnace' }),
      textField('room', 'Where it is', existing?.room, { placeholder: 'Basement' }),
      textField('manufacturer', 'Make', existing?.manufacturer),
      textField('model', 'Model', existing?.model, { mono: true }),
      textField('serial', 'Serial', existing?.serial, { mono: true }),
      textField('install_date', 'Installed', existing?.install_date,
        { placeholder: '2011-06, or just 2011' }),
      textArea('description', 'Notes', existing?.description,
        'Where exactly it is, quirks, anything you would want to remember.'),

      el('div.field', {},
        el('label', { for: 'servicer' }, 'Who services it'),
        el('input', {
          type: 'text', id: 'servicer', list: 'known-vendors',
          value: servicer?.company || '', placeholder: 'Leave blank if nobody in particular',
        }),
        el('datalist', { id: 'known-vendors' },
          knownVendors.map(v => el('option', { value: v.company }))),
        el('p.hint', {}, 'Kept as a contact you can open, not just a name here.')),

      t.fields.length ? el('h2', { style: 'margin-top:2rem' }, t.name) : null,
      t.fields.map(f => fieldFor(f, val(f.key))),
    );
  }

  const save = el('button', {}, existing ? 'Save changes' : 'Add it');
  save.onclick = async () => {
    const read = id => (body.querySelector(`#${CSS.escape(id)}`) || {}).value || '';
    const name = read('name').trim();
    if (!name) {
      note.textContent = 'Give it a name first — anything you would call it out loud.';
      note.className = 'note bad';
      note.hidden = false;
      return;
    }

    const t = template(slug);
    const values = Object.fromEntries(t.fields.map(f => [f.key, read(f.key)]));

    const ctx = await context();
    const { vendorId, ops: vendorOps } = await resolveVendor(read('servicer'), ctx);

    const { op, record } = buildPut('asset', {
      ...(existing || {}),
      name,
      template: slug,
      room: read('room').trim(),
      manufacturer: read('manufacturer').trim(),
      model: read('model').trim(),
      serial: read('serial').trim(),
      install_date: read('install_date').trim(),
      description: read('description').trim(),
      metadata: toMetadata(slug, values),
      status: existing?.status || 'active',
    }, { before: existing, ...ctx });

    const edgeOps = await setServicer(record.asset_id, vendorId, ctx);
    await writeOps([...vendorOps, op, ...edgeOps]);
    go(`#asset/${record.asset_id}`);
  };

  mount(root, el('div.column', {},
    el('section', {},
      el('h2', {}, existing ? `Edit ${existing.name}` : 'Add something'),
      el('div.field', {}, el('label', { for: 'template' }, 'What is it'), picker),
      body,
      el('div.actions', {},
        save,
        el('button.quiet', {
          onclick: () => go(existing ? `#asset/${existing.asset_id}` : '#assets'),
        }, 'Cancel')),
      note)));

  draw();
}

function textArea(id, label, value, hint) {
  return el('div.field', {},
    el('label', { for: id }, label),
    el('textarea', { id, rows: 3 }, value || ''),
    hint ? el('p.hint', {}, hint) : null);
}

function textField(id, label, value, { required, placeholder, mono } = {}) {
  return el('div.field', {},
    el('label', { for: id }, label),
    el('input', {
      type: 'text', id, value: value || '',
      placeholder: placeholder || '',
      required: required || null,
      class: mono ? 'ident' : null,
    }));
}

function fieldFor(f, value) {
  if (f.type === 'select') {
    const sel = el('select', { id: f.key });
    sel.append(el('option', { value: '' }, '—'));
    for (const o of f.options) sel.append(el('option', { value: o, selected: o === value }, o));
    return el('div.field', {}, el('label', { for: f.key }, f.label), sel);
  }

  return el('div.field', {},
    el('label', { for: f.key }, f.unit ? `${f.label} (${f.unit})` : f.label),
    el('input', {
      type: f.type === 'number' ? 'number' : 'text',
      id: f.key,
      value: value ?? '',
      placeholder: f.hint || '',
      class: f.type === 'ident' ? 'ident' : null,
    }));
}

// ── Record ──────────────────────────────────────────────────────────────────

export async function renderAsset(root, assetId) {
  const asset = await store.get('asset', assetId);
  if (!asset) {
    mount(root, el('div.column', {}, el('div.empty', {},
      el('h2', {}, 'Not here'),
      el('p', {}, 'That record is not in this archive. It may be on another device that has not synced yet.'),
      el('div.actions', {}, el('button.quiet', { onclick: () => go('#assets') }, 'Back')))));
    return;
  }

  const t = template(asset.template);
  const events = (await store.list('event', { index: 'asset_id', value: assetId }))
    .sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)));
  const live = events.filter(e => !e.superseded_by);
  const spent = live.reduce((n, e) => n + (e.cost || 0), 0);
  const { entries: revisions } = splitRevisions(asset.revisions);

  const vendors = new Map((await store.list('vendor')).map(v => [v.vendor_id, v.company]));
  const servicer = await servicerOf(assetId);

  mount(root, el('div.column', {},
    el('section', {},
      el('p.crumb', {}, el('a', { href: '#assets' }, 'All things')),
      el('h2.record-title', {}, asset.name),
      el('p.lede', {}, [t.name, asset.room].filter(Boolean).join(' · ')),
      asset.description ? el('p.description', {}, asset.description) : null,

      facts([
        ['Make', asset.manufacturer],
        ['Model', asset.model, true],
        ['Serial', asset.serial, true],
        ['Installed', asset.install_date],
        ...readMetadata(asset.template, asset.metadata).map(r =>
          [r.inTemplate ? r.label : `${r.label} (retired)`, r.value, r.type === 'ident']),
        ['Serviced by', servicer
          ? el('a', { href: `#vendor/${servicer.vendor_id}` }, servicer.company)
          : null],
        ['Spent so far', spent ? money(spent) : null],
      ]),

      el('div.actions', {},
        el('button', { onclick: () => go(`#asset/${assetId}/event`) }, 'Record something'),
        el('button.quiet', { onclick: () => go(`#asset/${assetId}/edit`) }, 'Edit details'))),

    el('section', {}, timeline(assetId, events, live, t, vendors)),
    revisions.length > 1 ? el('section', {}, history(revisions)) : null,
  ));
}

function timeline(assetId, events, live, t, vendors) {
  if (!live.length) {
    return el('div', {},
      el('h2', {}, 'History'),
      el('p.lede', {},
        'Nothing recorded yet. Every service, repair and inspection you log ' +
        'here stays for as long as you own this.'));
  }

  return el('div', {},
    el('h2', {}, `History — ${live.length} entr${live.length === 1 ? 'y' : 'ies'}`),
    el('ol.timeline', {}, live.map(e => el('li.entry', {},
      el('span.entry-date', {}, e.occurred_on),
      el('span.entry-body', {},
        el('span.entry-type', {}, e.type),
        e.vendor_id && vendors.get(e.vendor_id)
          ? el('span.entry-who', {}, vendors.get(e.vendor_id)) : null,
        e.notes ? el('span.entry-notes', {}, e.notes) : null,
        e.supersedes ? el('span.entry-flag', {}, 'corrects an earlier entry') : null),
      el('span.entry-cost', {},
        e.cost ? money(e.cost) : '',
        el('a.entry-fix', { href: `#asset/${assetId}/event/${e.event_id}` }, 'Correct'))))));
}

/**
 * Who changed what, when — kept on the record itself rather than derived from
 * a log somewhere else, so it travels with an export and survives whatever
 * happens to the sync history.
 */
function history(revisions) {
  return el('div', {},
    el('h2', {}, 'Changes to this record'),
    el('ol.timeline', {}, revisions.slice(0, 20).map(r => el('li.entry', {},
      el('span.entry-date', {}, ago(r.at)),
      el('span.entry-body', {},
        el('span.entry-notes', {},
          Object.entries(r.changes || {})
            .map(([k, [from, to]]) => from == null
              ? `set ${k} to ${short(to)}`
              : `${k}: ${short(from)} → ${short(to)}`)
            .join('; ')))))));
}

const short = v => {
  const s = typeof v === 'object' ? (v && v.v != null ? String(v.v) : JSON.stringify(v)) : String(v);
  return s.length > 40 ? `${s.slice(0, 38)}…` : s;
};

const money = cents => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// ── Recording an event ──────────────────────────────────────────────────────

export async function renderEventForm(root, assetId, correctsId = null) {
  const asset = await store.get('asset', assetId);
  if (!asset) return go('#assets');

  const corrects = correctsId ? await store.get('event', correctsId) : null;
  const t = template(asset.template);
  const suggestions = t.suggestedEvents || ['Service', 'Repair', 'Inspection'];

  const type = el('input', {
    type: 'text', id: 'type', list: 'event-types',
    value: corrects?.type || '', placeholder: suggestions[0],
  });
  const list = el('datalist', { id: 'event-types' },
    suggestions.map(s => el('option', { value: s })));

  const when = el('input', {
    type: 'text', id: 'when',
    value: corrects?.occurred_on || new Date().toISOString().slice(0, 10),
  });
  const cost = el('input', {
    type: 'text', id: 'cost',
    value: corrects?.cost != null ? (corrects.cost / 100).toFixed(2) : '',
    placeholder: '0.00',
  });
  const notes = el('input', { type: 'text', id: 'notes', value: corrects?.notes || '' });

  const vendors = await store.list('vendor');
  const priorVendor = corrects?.vendor_id
    ? vendors.find(v => v.vendor_id === corrects.vendor_id)
    : null;
  const who = el('input', {
    type: 'text', id: 'vendor', list: 'vendor-names',
    value: priorVendor?.company || '',
    placeholder: 'Company or person, if anyone',
  });
  const vendorList = el('datalist', { id: 'vendor-names' },
    vendors.map(v => el('option', { value: v.company })));

  const save = el('button', {}, corrects ? 'Save correction' : 'Record it');
  save.onclick = async () => {
    const ctx = await context();
    const { vendorId, ops: vendorOps } = await resolveVendor(who.value, ctx);
    const changes = {
      type: type.value.trim() || 'Note',
      occurred_on: when.value.trim(),
      cost: cost.value.trim() ? Math.round(Number(cost.value) * 100) : null,
      notes: notes.value.trim(),
      vendor_id: vendorId,
    };

    if (corrects) {
      // Never an edit. The original keeps what was recorded and the new entry
      // supersedes it, so the archive stays accurate without losing what it
      // said before.
      const { ops } = buildCorrection(corrects, changes, ctx);
      await writeOps([...vendorOps, ...ops]);
    } else {
      const { op } = buildPut('event', { asset_id: assetId, ...changes }, ctx);
      await writeOps([...vendorOps, op]);
    }
    go(`#asset/${assetId}`);
  };

  mount(root, el('div.column', {},
    el('section', {},
      el('p.crumb', {}, el('a', { href: `#asset/${assetId}` }, asset.name)),
      el('h2', {}, corrects ? 'Correct an entry' : 'Record something'),
      corrects ? el('p.lede', {},
        'The original entry stays in the history, marked as corrected. ' +
        'Nothing is overwritten.') : null,

      el('div.field', {}, el('label', { for: 'type' }, 'What happened'), type, list),
      el('div.field', {}, el('label', { for: 'when' }, 'When'), when,
        el('p.hint', {}, 'A year on its own is fine if that is all you know.')),
      el('div.field', {}, el('label', { for: 'vendor' }, 'Who did it'), who, vendorList,
        el('p.hint', {}, 'Kept as a contact, so you can see everything they have worked on.')),
      el('div.field', {}, el('label', { for: 'cost' }, 'Cost'), cost),
      el('div.field', {}, el('label', { for: 'notes' }, 'Notes'), notes),

      el('div.actions', {},
        save,
        el('button.quiet', { onclick: () => go(`#asset/${assetId}`) }, 'Cancel')))));
}
