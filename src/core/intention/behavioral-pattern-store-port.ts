import type {
  BehavioralPatternListOptions,
  BehavioralPatternOutcomeInput,
  BehavioralPatternPromotionHook,
  BehavioralPatternRecordInput,
  BehavioralPatternSample,
  BehavioralPatternSummaryOptions,
  BehavioralResponseStrategy,
  BehavioralStrategySummary,
} from './patterns.js';

type Awaitable<T> = T | Promise<T>;

export interface BehavioralPatternLatestPendingOutcomeInput {
  contactId: string;
  outcomeScore: number;
  observedAt?: string;
  strategy?: BehavioralResponseStrategy;
  outcomeSourceMessageId?: string;
}

export interface BehavioralPatternStorePortBackend {
  setPromotionHook(hook: BehavioralPatternPromotionHook | null): void;
  recordResponseStrategy(input: BehavioralPatternRecordInput): Awaitable<BehavioralPatternSample>;
  recordOutcomeForSample(input: BehavioralPatternOutcomeInput): Awaitable<BehavioralPatternSample>;
  tryRecordOutcomeForLatestPending(
    input: BehavioralPatternLatestPendingOutcomeInput,
  ): Awaitable<BehavioralPatternSample | null>;
  listSamples(options: BehavioralPatternListOptions): Awaitable<BehavioralPatternSample[]>;
  listStrategySummaries(
    contactId: string,
    options?: BehavioralPatternSummaryOptions,
  ): Awaitable<BehavioralStrategySummary[]>;
}

export interface BehavioralPatternStorePort {
  setPromotionHook(hook: BehavioralPatternPromotionHook | null): void;
  recordResponseStrategy(input: BehavioralPatternRecordInput): Promise<BehavioralPatternSample>;
  recordOutcomeForSample(input: BehavioralPatternOutcomeInput): Promise<BehavioralPatternSample>;
  tryRecordOutcomeForLatestPending(
    input: BehavioralPatternLatestPendingOutcomeInput,
  ): Promise<BehavioralPatternSample | null>;
  listSamples(options: BehavioralPatternListOptions): Promise<BehavioralPatternSample[]>;
  listStrategySummaries(
    contactId: string,
    options?: BehavioralPatternSummaryOptions,
  ): Promise<BehavioralStrategySummary[]>;
}

export function createBehavioralPatternStorePort(
  store: BehavioralPatternStorePortBackend,
): BehavioralPatternStorePort {
  return {
    setPromotionHook: (hook) => {
      store.setPromotionHook(hook);
    },
    recordResponseStrategy: async (input) => await store.recordResponseStrategy(input),
    recordOutcomeForSample: async (input) => await store.recordOutcomeForSample(input),
    tryRecordOutcomeForLatestPending: async (input) => (
      await store.tryRecordOutcomeForLatestPending(input)
    ),
    listSamples: async (options) => await store.listSamples(options),
    listStrategySummaries: async (contactId, options) => (
      await store.listStrategySummaries(contactId, options)
    ),
  };
}
