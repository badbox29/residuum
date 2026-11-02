/**
 * templates.js — the built-in asset types.
 *
 * There is one Asset model. A template only decides which extra fields an
 * asset collects and how they are presented, so adding a type never changes
 * the database.
 *
 * Built-ins live here, in code, versioned with the app. Seeding them into
 * every archive instead would freeze each person's copy at the moment they
 * started: a fix to the HVAC template would never reach anyone, and
 * correcting a typo would mean migrating every device.
 *
 * ── Rules for editing this file ─────────────────────────────────────────────
 *
 * Fields may be ADDED and may be DEPRECATED. A key must never be removed or
 * change type. Someone's furnace recorded in 2026 has to stay readable in
 * 2041, and self-describing metadata only protects a record if the key it was
 * written under keeps meaning the same thing.
 *
 * Field types:
 *   text    free text
 *   ident   an identifier — VIN, serial, model. Searched by substring rather
 *           than tokenised, because people remember fragments of these.
 *   number  numeric, with an optional unit
 *   money   stored as integer cents
 *   date    ISO, and deliberately allows partial values: 'the roof went on in
 *           2009' is real information and should not need a made-up month.
 *   select  one of options
 */

export const TEMPLATES = {
  generic: {
    name: 'Something else', category: 'General', icon: '◻',
    fields: [],
  },

  hvac: {
    name: 'HVAC', category: 'Infrastructure', icon: '❅',
    lifespanYears: 18,
    fields: [
      { key: 'filter_size', label: 'Filter size', type: 'text', hint: 'e.g. 20x25x1' },
      { key: 'refrigerant', label: 'Refrigerant', type: 'select',
        options: ['R-410A', 'R-22', 'R-32', 'R-454B'] },
      { key: 'capacity', label: 'Capacity', type: 'number', unit: 'BTU/hr' },
      { key: 'thermostat', label: 'Thermostat', type: 'text' },
    ],
    suggestedEvents: ['Filter change', 'Service', 'Inspection', 'Repair'],
  },

  furnace: {
    name: 'Furnace', category: 'Infrastructure', icon: '♨',
    lifespanYears: 20,
    fields: [
      { key: 'fuel', label: 'Fuel', type: 'select', options: ['Natural gas', 'Propane', 'Oil', 'Electric'] },
      { key: 'filter_size', label: 'Filter size', type: 'text' },
      { key: 'input_btu', label: 'Input', type: 'number', unit: 'BTU/hr' },
      { key: 'efficiency', label: 'AFUE', type: 'number', unit: '%' },
    ],
    suggestedEvents: ['Filter change', 'Annual service', 'Inspection', 'Repair'],
  },

  water_heater: {
    name: 'Water heater', category: 'Infrastructure', icon: '♨',
    lifespanYears: 12,
    fields: [
      { key: 'capacity', label: 'Capacity', type: 'number', unit: 'gal' },
      { key: 'fuel', label: 'Fuel', type: 'select', options: ['Natural gas', 'Propane', 'Electric', 'Heat pump', 'Tankless'] },
      { key: 'anode', label: 'Anode rod', type: 'text' },
    ],
    suggestedEvents: ['Flush', 'Anode replacement', 'Inspection', 'Repair'],
  },

  roof: {
    name: 'Roof', category: 'Infrastructure', icon: '⌂',
    lifespanYears: 25,
    fields: [
      { key: 'material', label: 'Material', type: 'select',
        options: ['Asphalt shingle', 'Architectural shingle', 'Metal', 'Tile', 'Slate', 'Flat / membrane'] },
      { key: 'pitch', label: 'Pitch', type: 'text', hint: 'e.g. 6/12' },
      { key: 'squares', label: 'Area', type: 'number', unit: 'squares' },
      { key: 'warranty_years', label: 'Warranty', type: 'number', unit: 'years' },
    ],
    suggestedEvents: ['Inspection', 'Repair', 'Replacement', 'Storm damage'],
  },

  breaker_panel: {
    name: 'Breaker panel', category: 'Infrastructure', icon: '⚡',
    lifespanYears: 40,
    fields: [
      { key: 'amperage', label: 'Service', type: 'number', unit: 'A' },
      { key: 'spaces', label: 'Spaces', type: 'number' },
      { key: 'voltage', label: 'Voltage', type: 'select', options: ['120/240V', '120/208V'] },
      { key: 'panel_type', label: 'Type', type: 'select', options: ['Main', 'Subpanel'] },
    ],
    suggestedEvents: ['Inspection', 'Breaker replacement', 'Circuit added', 'Repair'],
  },

  generator: {
    name: 'Generator', category: 'Infrastructure', icon: '⚙',
    lifespanYears: 20,
    fields: [
      { key: 'output', label: 'Output', type: 'number', unit: 'kW' },
      { key: 'fuel', label: 'Fuel', type: 'select', options: ['Natural gas', 'Propane', 'Diesel', 'Gasoline'] },
      { key: 'transfer_switch', label: 'Transfer switch', type: 'text' },
      { key: 'run_hours', label: 'Hours', type: 'number', unit: 'h' },
    ],
    suggestedEvents: ['Oil change', 'Exercise run', 'Service', 'Repair'],
  },

  vehicle: {
    name: 'Vehicle', category: 'Vehicle', icon: '⛟',
    lifespanYears: 15,
    fields: [
      { key: 'vin', label: 'VIN', type: 'ident' },
      { key: 'plate', label: 'Plate', type: 'ident' },
      { key: 'year', label: 'Year', type: 'number' },
      { key: 'odometer', label: 'Odometer', type: 'number', unit: 'mi' },
      { key: 'fuel', label: 'Fuel', type: 'select',
        options: ['Gasoline', 'Diesel', 'Hybrid', 'Electric'] },
      { key: 'tire_size', label: 'Tire size', type: 'text', hint: 'e.g. 265/70R17' },
    ],
    suggestedEvents: ['Oil change', 'Tire rotation', 'Fuel', 'Service', 'Registration', 'Repair'],
  },

  appliance: {
    name: 'Appliance', category: 'Equipment', icon: '▣',
    lifespanYears: 12,
    fields: [
      { key: 'kind', label: 'Kind', type: 'select',
        options: ['Refrigerator', 'Dishwasher', 'Oven', 'Range', 'Microwave', 'Washer', 'Dryer', 'Freezer'] },
      { key: 'capacity', label: 'Capacity', type: 'text' },
      { key: 'filter', label: 'Filter', type: 'text' },
    ],
    suggestedEvents: ['Filter change', 'Repair', 'Service'],
  },

  outdoor: {
    name: 'Outdoor structure', category: 'Outdoor', icon: '⌗',
    lifespanYears: 20,
    fields: [
      { key: 'kind', label: 'Kind', type: 'select',
        options: ['Deck', 'Fence', 'Shed', 'Patio', 'Driveway', 'Retaining wall'] },
      { key: 'material', label: 'Material', type: 'text' },
      { key: 'dimensions', label: 'Dimensions', type: 'text' },
    ],
    suggestedEvents: ['Stain / seal', 'Repair', 'Inspection', 'Replacement'],
  },

  tool: {
    name: 'Tool or equipment', category: 'Collection', icon: '⚒',
    fields: [
      { key: 'kind', label: 'Kind', type: 'text' },
      { key: 'power', label: 'Power', type: 'select', options: ['Manual', 'Corded', 'Cordless', 'Gas', 'Pneumatic'] },
      { key: 'battery', label: 'Battery platform', type: 'text' },
    ],
    suggestedEvents: ['Service', 'Repair', 'Blade / bit replacement'],
  },
};

export const TEMPLATE_SLUGS = Object.keys(TEMPLATES);

export function template(slug) {
  return TEMPLATES[slug] || TEMPLATES.generic;
}

/** Grouped for the picker, which is long enough to need headings. */
export function templatesByCategory() {
  const out = new Map();
  for (const [slug, t] of Object.entries(TEMPLATES)) {
    if (!out.has(t.category)) out.set(t.category, []);
    out.get(t.category).push({ slug, ...t });
  }
  return out;
}

/**
 * Turn form values into self-describing metadata.
 *
 * Each entry stores its own label and type alongside the value. That costs a
 * few bytes and buys the thing the archive is actually for: a bare
 * `{"capacity": 60000}` is only interpretable while you still have the
 * template that produced it, whereas an entry carrying its own label stays
 * readable after the template changes, or is deleted, or the app that wrote
 * it is long gone.
 */
export function toMetadata(slug, values) {
  const t = template(slug);
  const out = {};
  for (const field of t.fields) {
    const raw = values[field.key];
    if (raw == null || raw === '') continue;
    out[field.key] = {
      v: field.type === 'number' || field.type === 'money' ? Number(raw) : raw,
      label: field.label,
      type: field.type,
      ...(field.unit ? { unit: field.unit } : {}),
    };
  }
  return out;
}

/**
 * Everything to display for an asset, in template order, with anything the
 * template no longer knows about appended rather than hidden.
 *
 * Never drop a value because the current template lacks its key. Silent
 * hiding is worse than deletion: nothing tells you it happened, and the data
 * is still sitting there taking up space in every sync.
 */
export function readMetadata(slug, metadata = {}) {
  const t = template(slug);
  const seen = new Set();
  const rows = [];

  for (const field of t.fields) {
    const entry = metadata[field.key];
    if (entry == null) continue;
    seen.add(field.key);
    rows.push({
      key: field.key,
      label: field.label,          // the template's label wins while it has one
      value: display(entry),
      type: field.type,
      inTemplate: true,
    });
  }

  for (const [key, entry] of Object.entries(metadata)) {
    if (seen.has(key)) continue;
    rows.push({
      key,
      label: (entry && entry.label) || key,   // fall back to what it was recorded as
      value: display(entry),
      type: (entry && entry.type) || 'text',
      inTemplate: false,
    });
  }

  return rows;
}

function display(entry) {
  if (entry == null) return '';
  if (typeof entry !== 'object') return String(entry);   // tolerate bare values
  const v = entry.v;
  if (v == null) return '';
  if (entry.type === 'money') return `$${(Number(v) / 100).toFixed(2)}`;
  return entry.unit ? `${v} ${entry.unit}` : String(v);
}
