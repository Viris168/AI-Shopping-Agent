// Every migration must be listed here, in order (explicit imports work for both dist/ and tests).
import { Init1794128955639 } from './1794128955639-Init.js';
import { SearchIndexes1794129000000 } from './1794129000000-SearchIndexes.js';
import { AgentHardening1794130000000 } from './1794130000000-AgentHardening.js';

export const MIGRATIONS = [
  Init1794128955639,
  SearchIndexes1794129000000,
  AgentHardening1794130000000,
];
