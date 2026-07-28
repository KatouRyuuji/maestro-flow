import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const scoreSchema = z.number().finite().min(0).max(1);

export const knowledgeDispositionSchema = z.enum([
  'unique',
  'exact_duplicate',
  'semantic_duplicate',
  'extends',
  'related',
  'potential_conflict',
  'supersede_candidate',
]);

export const knowledgePromotionEligibilitySchema = z.enum([
  'eligible',
  'review_required',
  'suppressed',
]);

export const knowledgeResolutionSchema = z.object({
  status: z.enum(['automatic', 'confirmed']),
  reason: nonEmptyString,
  resolved_at: nonEmptyString,
}).strict();

export const knowledgeReconciliationMatchSchema = z.object({
  knowledge_id: nonEmptyString,
  target: z.enum(['spec', 'knowhow']),
  title: nonEmptyString,
  relation: knowledgeDispositionSchema.exclude(['unique']),
  scores: z.object({
    lexical: scoreSchema,
    semantic: scoreSchema,
    title: scoreSchema,
    relation: scoreSchema,
    stance: scoreSchema,
    composite: scoreSchema,
  }).strict(),
  novelty: scoreSchema,
  evidence: z.array(nonEmptyString),
  target_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_path: nonEmptyString,
  source_line: z.number().int().positive().nullable(),
}).strict();

export const knowledgeCandidateReconciliationSchema = z.object({
  candidate_id: z.string().regex(/^KDC-[a-f0-9]{16}$/),
  disposition: knowledgeDispositionSchema,
  promotion_eligibility: knowledgePromotionEligibilitySchema,
  canonical_id: z.string().min(1).nullable(),
  matches: z.array(knowledgeReconciliationMatchSchema),
  resolution: knowledgeResolutionSchema.nullable(),
}).strict();

export const knowledgeReconciliationSchema = z.object({
  schema_version: z.literal('knowledge-reconciliation/1.0'),
  session_id: nonEmptyString,
  run_id: nonEmptyString,
  candidate_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  corpus_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  matcher_revision: z.literal('semantic-delta/1.0'),
  generated_at: nonEmptyString,
  retrieval: z.object({
    mode: z.enum(['lexical-kg', 'hybrid']),
    embedding_used: z.boolean(),
    candidate_limit: z.number().int().positive(),
    identity_documents: z.number().int().nonnegative(),
    semantic_documents: z.number().int().nonnegative(),
    relation_documents: z.number().int().nonnegative(),
  }).strict(),
  counts: z.object({
    candidates: z.number().int().nonnegative(),
    unique: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    related: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    review_required: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
  }).strict(),
  candidates: z.array(knowledgeCandidateReconciliationSchema),
}).strict();

export type KnowledgeDisposition = z.infer<typeof knowledgeDispositionSchema>;
export type KnowledgePromotionEligibility = z.infer<typeof knowledgePromotionEligibilitySchema>;
export type KnowledgeReconciliation = z.infer<typeof knowledgeReconciliationSchema>;
export type KnowledgeCandidateReconciliation = z.infer<typeof knowledgeCandidateReconciliationSchema>;
