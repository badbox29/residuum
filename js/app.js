// Entry point. UI comes after the storage layer.
import { ENTITY_NAMES } from './entities.js';

document.getElementById('app').textContent =
  `Residuum — storage layer in progress (${ENTITY_NAMES.length} record types).`;
