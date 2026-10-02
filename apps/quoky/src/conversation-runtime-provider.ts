import {
  ConversationRuntime,
  DefaultMemoryWriter,
  type ConversationRuntimeDeps,
  type ConversationRuntimeOptions,
  type MemoryManager,
} from '@quoky/core';

export type ProductionConversationRuntimeDeps = Omit<ConversationRuntimeDeps, 'memoryWriter'>;

/** Keep the production durable-memory writer choice explicit and independently testable. */
export function createProductionConversationRuntime(
  memory: MemoryManager,
  deps: ProductionConversationRuntimeDeps,
  options: ConversationRuntimeOptions = {},
): ConversationRuntime {
  return new ConversationRuntime(
    {
      ...deps,
      memoryWriter: new DefaultMemoryWriter(memory),
    },
    options,
  );
}
