// Every migration must be listed here, in order (explicit imports work for both dist/ and tests).
import { Init1794128955639 } from './1794128955639-Init.js';
import { SearchIndexes1794129000000 } from './1794129000000-SearchIndexes.js';
import { AgentHardening1794130000000 } from './1794130000000-AgentHardening.js';
import { Conversations1794140351353 } from './1794140351353-Conversations.js';
import { Payments1794163827211 } from './1794163827211-Payments.js';
import { HelpdeskForwarding1794170000000 } from './1794170000000-HelpdeskForwarding.js';
import { Embeddings1794180000000 } from './1794180000000-Embeddings.js';
import { TokenVersion1794190000000 } from './1794190000000-TokenVersion.js';
import { AgentMemory1794200000000 } from './1794200000000-AgentMemory.js';
import { ConversationCost1794210000000 } from './1794210000000-ConversationCost.js';

export const MIGRATIONS = [
  Init1794128955639,
  SearchIndexes1794129000000,
  AgentHardening1794130000000,
  Conversations1794140351353,
  Payments1794163827211,
  HelpdeskForwarding1794170000000,
  Embeddings1794180000000,
  TokenVersion1794190000000,
  AgentMemory1794200000000,
  ConversationCost1794210000000,
];
