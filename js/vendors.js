/**
 * vendors.js — the people and companies who work on your things.
 *
 * A vendor is a record rather than a name typed into a note, which is what
 * makes "everything this contractor has ever touched, and what it cost"
 * answerable at all. That question is one of the reasons the archive exists.
 */

import { el, mount, facts } from './dom.js';
import * as store from './store.js';
import { buildPut, buildTombstone } from './oplog.js';
import { template } from './templates.js';
import { context, writeOps } from './actions.js';

const go = hash => { location.hash = hash; };
const money = cents => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// ── Helpers shared with the asset views ─────────────────────────────────────

/**
 * Find a vendor by company name, or create one.
 *
 * Typing a name is the whole interaction — no separate screen to visit first,
 * and the record it creates is a real vendor from that moment.
 */
export async function resolveVendor(name, ctx) {
  const company = String(name || '').trim();
  if (!company) return { vendorId: null, ops: [] };

  const existing = (await store.list('vendor'))
    .find(v => v.company.toLowerCase() === company.toLowerCase());
  if (existing) return { vendorId: existing.vendor_id, ops: [] };

  const { op, record } = buildPut('vendor', { company }, ctx);
  return { vendorId: record.vendor_id, ops: [op] };
}

/**
 * Who normally services an asset, as a relationship rather than a field.
 *
 * An edge is traversable both ways at the same cost, so this one fact answers
 * "who looks after the furnace" and "what does this company look after"
 * without storing it twice and keeping the copies in step.
 */
export async function servicerOf(assetId) {
  const edges = await store.edges({ from: { type: 'asset', id: assetId }, kind: 'serviced_by' });
  if (!edges.length) return null;
  return store.get('vendor', edges[0].to_id);
}

export async function setServicer(assetId, vendorId, ctx) {
  const existing = await store.edges({ from: { type: 'asset', id: assetId }, kind: 'serviced_by' });
  const ops = [];

  // Retire any edge that is not the one being set. Tombstoned, not removed —
  // the fact that a different company used to look after this is history too.
  for (const edge of existing) {
    if (edge.to_id === vendorId) return ops;
    ops.push(buildTombstone('relationship', edge.rel_id, ctx).op);
  }

  if (vendorId) {
    ops.push(buildPut('relationship', {
      from_type: 'asset', from_id: assetId, kind: 'serviced_by',
      to_type: 'vendor', to_id: vendorId,
    }, ctx).op);
  }
  return ops;
}

// ── List ────────────────────────────────────────────────────────────────────

export async function renderVendors(root) {
  const vendors = await store.list('vendor');

  if (!vendors.length) {
    mount(root, el('div.column', {}, el('div.empty', {},
      el('h2', {}, 'No one yet'),
      el('p', {},
        'Companies and people appear here as you record who did the work. ' +
        'You can also add one now and fill in their details.'),
      el('div.actions', {}, el('button', { onclick: () => go('#vendor-new') }, 'Add a contact')))));
    return;
  }

  const events = await store.list('event');
  vendors.sort((a, b) => a.company.localeCompare(b.company));

  mount(root, el('div.column', {},
    el('section', {},
      el('div.row-between', {},
        el('h2', {}, `${vendors.length} contact${vendors.length === 1 ? '' : 's'}`),
        el('button', { onclick: () => go('#vendor-new') }, 'Add')),
      el('ul.records', {}, vendors.map(v => {
        const theirs = events.filter(e => e.vendor_id === v.vendor_id && !e.superseded_by);
        const spent = theirs.reduce((n, e) => n + (e.cost || 0), 0);
        return el('li.record', {},
          el('a', { href: `#vendor/${v.vendor_id}` },
            el('span.record-icon', {}, '✇'),
            el('span.record-body', {},
              el('span.record-name', {}, v.company),
              el('span.record-meta', {}, v.phone || v.email || 'No contact details yet')),
            el('span.record-aside', {},
              theirs.length
                ? `${theirs.length} job${theirs.length === 1 ? '' : 's'}${spent ? `, ${money(spent)}` : ''}`
                : '')));
      })))));
}

// ── Detail ──────────────────────────────────────────────────────────────────

export async function renderVendor(root, vendorId) {
  const vendor = await store.get('vendor', vendorId);
  if (!vendor) {
    mount(root, el('div.column', {}, el('div.empty', {},
      el('h2', {}, 'Not here'),
      el('p', {}, 'That contact is not in this archive.'),
      el('div.actions', {}, el('button.quiet', { onclick: () => go('#vendors') }, 'Back')))));
    return;
  }

  const allEvents = await store.list('event');
  const theirs = allEvents
    .filter(e => e.vendor_id === vendorId && !e.superseded_by)
    .sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)));
  const spent = theirs.reduce((n, e) => n + (e.cost || 0), 0);

  const assets = new Map((await store.list('asset')).map(a => [a.asset_id, a]));

  // Everything they are the standing servicer for, which may include things
  // they have not billed for yet.
  const edges = await store.edges({ to: { type: 'vendor', id: vendorId }, kind: 'serviced_by' });
  const looksAfter = edges.map(e => assets.get(e.from_id)).filter(Boolean);

  mount(root, el('div.column', {},
    el('section', {},
      el('p.crumb', {}, el('a', { href: '#vendors' }, 'All contacts')),
      el('h2.record-title', {}, vendor.company),
      vendor.notes ? el('p.description', {}, vendor.notes) : null,

      facts([
        ['Contact', vendor.contact],
        ['Phone', vendor.phone, true],
        ['Email', vendor.email],
        ['Website', vendor.website
          ? el('a', { href: external(vendor.website), rel: 'noreferrer noopener', target: '_blank' },
              vendor.website)
          : null],
        ['Jobs recorded', theirs.length || null],
        ['Spent over time', spent ? money(spent) : null],
      ]),

      el('div.actions', {},
        el('button.quiet', { onclick: () => go(`#vendor/${vendorId}/edit`) }, 'Edit details'))),

    looksAfter.length ? el('section', {},
      el('h2', {}, 'Looks after'),
      el('ul.records', {}, looksAfter.map(a =>
        el('li.record', {}, el('a', { href: `#asset/${a.asset_id}` },
          el('span.record-icon', {}, template(a.template).icon || '◻'),
          el('span.record-body', {},
            el('span.record-name', {}, a.name),
            el('span.record-meta', {}, [template(a.template).name, a.room].filter(Boolean).join(', '))),
          el('span.record-aside', {}, '')))))) : null,

    theirs.length ? el('section', {},
      el('h2', {}, `Work done — ${theirs.length}`),
      el('ol.timeline', {}, theirs.map(e => {
        const on = assets.get(e.asset_id);
        return el('li.entry', {},
          el('span.entry-date', {}, e.occurred_on),
          el('span.entry-body', {},
            el('span.entry-type', {}, e.type),
            on ? el('span.entry-who', {},
              el('a', { href: `#asset/${on.asset_id}` }, on.name)) : null,
            e.notes ? el('span.entry-notes', {}, e.notes) : null),
          el('span.entry-cost', {}, e.cost ? money(e.cost) : ''));
      }))) : null,
  ));
}

const external = url => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

// ── Edit ────────────────────────────────────────────────────────────────────

export async function renderVendorForm(root, vendorId = null) {
  const existing = vendorId ? await store.get('vendor', vendorId) : null;
  const note = el('p.note', { hidden: true });

  const field = (id, label, value, placeholder, mono) => el('div.field', {},
    el('label', { for: id }, label),
    el('input', { type: 'text', id, value: value || '', placeholder: placeholder || '',
      class: mono ? 'ident' : null }));

  const form = el('div', {},
    field('company', 'Company or person', existing?.company, 'Lanehart Electrical'),
    field('contact', 'Who you deal with', existing?.contact),
    field('phone', 'Phone', existing?.phone, '(678) 555-0142', true),
    field('email', 'Email', existing?.email),
    field('website', 'Website', existing?.website, 'lanehart.com'),
    el('div.field', {},
      el('label', { for: 'notes' }, 'Notes'),
      el('textarea', { id: 'notes', rows: 3 }, existing?.notes || ''),
      el('p.hint', {}, 'Account numbers, who to ask for, what they are good at.')));

  const save = el('button', {}, existing ? 'Save changes' : 'Add contact');
  save.onclick = async () => {
    const read = id => (form.querySelector(`#${CSS.escape(id)}`) || {}).value || '';
    const company = read('company').trim();
    if (!company) {
      note.textContent = 'A company or person needs a name.';
      note.className = 'note bad';
      note.hidden = false;
      return;
    }

    const { op, record } = buildPut('vendor', {
      ...(existing || {}),
      company,
      contact: read('contact').trim(),
      phone: read('phone').trim(),
      email: read('email').trim(),
      website: read('website').trim(),
      notes: read('notes').trim(),
    }, { before: existing, ...(await context()) });

    await writeOps([op]);
    go(`#vendor/${record.vendor_id}`);
  };

  mount(root, el('div.column', {},
    el('section', {},
      el('p.crumb', {}, el('a', { href: existing ? `#vendor/${vendorId}` : '#vendors' }, 'Back')),
      el('h2', {}, existing ? `Edit ${existing.company}` : 'Add a contact'),
      form,
      el('div.actions', {},
        save,
        el('button.quiet', {
          onclick: () => go(existing ? `#vendor/${vendorId}` : '#vendors'),
        }, 'Cancel')),
      note)));
}
