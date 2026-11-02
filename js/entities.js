/**
 * entities.js — the single description of every record type.
 *
 * Drives the IndexedDB object stores, the merge rules, and the search index.
 * Adding a field is a change here and nowhere else.
 *
 * `strategy` selects the merge rule (see merge.js):
 *   'lww'       last updated_at wins; revisions union — mutable records
 *   'immutable' first write wins, later writes ignored — events
 *   'union'     union with add-wins-over-remove — relationships, documents
 */

export const ENTITIES = {
  asset: {
    store: 'assets',
    pk: 'asset_id',
    strategy: 'lww',
    hasRevisions: true,
    indexes: ['property_id', 'template', 'status'],
    // Tokenised for search: prose.
    searchText: ['name', 'description', 'room'],
    // Substring-scanned for search: identifiers. A tokeniser would split
    // 'A3-4471X' and lose the fragment someone half-remembers off a sticker.
    searchIdent: ['serial', 'model', 'barcode'],
    json: ['tags', 'metadata', 'revisions'],
    fields: [
      'asset_id', 'property_id', 'template', 'template_version', 'name',
      'status', 'room', 'description', 'manufacturer', 'model', 'serial',
      'purchase_date', 'install_date', 'purchase_price', 'warranty_until',
      'expected_life_years', 'barcode', 'tags', 'metadata', 'revisions',
      'updated_at', 'updated_by', 'tombstoned_at',
    ],
  },

  event: {
    store: 'events',
    pk: 'event_id',
    strategy: 'immutable',
    hasRevisions: false,
    indexes: ['asset_id', 'vendor_id', 'occurred_on'],
    searchText: ['notes', 'type'],
    searchIdent: [],
    json: ['metadata'],
    fields: [
      'event_id', 'asset_id', 'type', 'occurred_on', 'cost', 'vendor_id',
      'notes', 'metadata', 'created_at', 'created_by', 'supersedes',
      'superseded_by',
    ],
    // The one field on an otherwise immutable record a later write may set —
    // a correction has to point back at what it corrects. Nothing else about
    // an event is ever overwritten.
    mutableFields: ['superseded_by'],
  },

  relationship: {
    store: 'relationships',
    pk: 'rel_id',
    strategy: 'union',
    hasRevisions: false,
    // Both directions indexed, so "what does this breaker feed" and "what
    // powers this HVAC" cost the same.
    indexes: ['from_id', 'to_id', 'kind'],
    searchText: [],
    searchIdent: [],
    json: ['metadata'],
    fields: [
      'rel_id', 'from_type', 'from_id', 'kind', 'to_type', 'to_id',
      'metadata', 'created_at', 'tombstoned_at',
    ],
  },

  document: {
    store: 'documents',
    pk: 'document_id',
    strategy: 'union',
    hasRevisions: false,
    indexes: ['attached_to_id', 'sha256', 'kind'],
    searchText: ['filename', 'caption'],
    searchIdent: [],
    json: [],
    fields: [
      'document_id', 'sha256', 'filename', 'mime_type', 'byte_size', 'kind',
      'caption', 'attached_to_type', 'attached_to_id', 'created_at',
      'tombstoned_at',
    ],
  },

  property: {
    store: 'properties',
    pk: 'property_id',
    strategy: 'lww',
    hasRevisions: true,
    indexes: [],
    searchText: ['name', 'address'],
    searchIdent: [],
    json: ['metadata', 'revisions'],
    fields: [
      'property_id', 'name', 'kind', 'address', 'acquired_on', 'metadata',
      'revisions', 'updated_at', 'updated_by', 'tombstoned_at',
    ],
  },

  vendor: {
    store: 'vendors',
    pk: 'vendor_id',
    strategy: 'lww',
    hasRevisions: true,
    indexes: [],
    searchText: ['company', 'contact', 'notes'],
    searchIdent: ['phone'],
    json: ['revisions'],
    fields: [
      'vendor_id', 'company', 'contact', 'phone', 'email', 'website', 'notes',
      'revisions', 'updated_at', 'updated_by', 'tombstoned_at',
    ],
  },

  consumable: {
    store: 'consumables',
    pk: 'consumable_id',
    strategy: 'lww',
    hasRevisions: true,
    indexes: [],
    searchText: ['name', 'notes'],
    searchIdent: ['spec', 'part_number'],
    json: ['revisions'],
    fields: [
      'consumable_id', 'name', 'spec', 'part_number', 'notes', 'revisions',
      'updated_at', 'updated_by', 'tombstoned_at',
    ],
  },

  template: {
    store: 'templates',
    pk: 'template_id',
    strategy: 'lww',
    hasRevisions: true,
    indexes: ['slug'],
    searchText: ['name'],
    searchIdent: [],
    json: ['field_schema', 'default_events', 'recurring', 'revisions'],
    fields: [
      'template_id', 'slug', 'forked_from', 'name', 'category', 'icon',
      'field_schema', 'default_events', 'recurring', 'revisions',
      'updated_at', 'updated_by', 'tombstoned_at',
    ],
  },
};

export const ENTITY_NAMES = Object.keys(ENTITIES);

export function entityDef(entity) {
  const def = ENTITIES[entity];
  if (!def) throw new Error(`Unknown entity: ${entity}`);
  return def;
}

/**
 * Reduce an arbitrary object to exactly this entity's declared fields.
 *
 * Unknown keys are dropped rather than carried through, so a record arriving
 * from another device cannot introduce fields nothing here understands.
 */
export function pick(entity, record) {
  const def = entityDef(entity);
  const out = {};
  for (const f of def.fields) if (record[f] !== undefined) out[f] = record[f];
  return out;
}
