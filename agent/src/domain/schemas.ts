import { z } from 'zod'

export const dataFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  sampledValues: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
})

export const dataCardSchema = z.object({
  assetId: z.string().min(1),
  path: z.string().min(1),
  assetType: z.enum(['raster', 'vector', 'csv']),
  filename: z.string().min(1),
  semanticHints: z.array(z.string()).default([]),
  spatial: z
    .object({
      crs: z.string().optional(),
      bounds: z.array(z.number()).length(4).optional(),
      resolution: z.tuple([z.number(), z.number()]).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .optional(),
  tabular: z
    .object({
      fields: z.array(dataFieldSchema),
      rowCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  raster: z
    .object({
      bands: z.number().int().positive(),
      dataType: z.string().optional(),
      nodata: z.number().optional(),
      sampledCodes: z.array(z.number()).optional(),
    })
    .optional(),
  provenance: z.object({
    source: z.enum(['user-local', 'derived']),
    fingerprint: z.string().min(1),
  }),
})

export const inputSlotSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  valueType: z.enum(['raster', 'vector', 'csv', 'number', 'boolean', 'string']),
  semanticRole: z.string().min(1),
  semanticTerms: z.array(z.string()).default([]),
  requiredFields: z.array(z.string()).default([]),
  relationConstraints: z
    .array(
      z.object({
        kind: z.enum(['code-coverage', 'spatial-overlap', 'same-crs']),
        otherSlot: z.string().min(1),
        field: z.string().optional(),
      }),
    )
    .default([]),
})

export const modelInputSchemaSchema = z.object({
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),
  slots: z.array(inputSlotSchema),
})

export const evidenceSchema = z.object({
  kind: z.enum([
    'asset-type',
    'filename',
    'semantic-hint',
    'required-field',
    'relation-check',
    'user-confirmation',
  ]),
  message: z.string().min(1),
  weight: z.number(),
  source: z.enum(['tool', 'agent', 'user']),
})

export const candidateSchema = z.object({
  assetId: z.string().min(1),
  score: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
  rejected: z.boolean(),
  rejectionReasons: z.array(z.string()),
})

export const candidateSetSchema = z.object({
  slot: z.string().min(1),
  candidates: z.array(candidateSchema),
})

export const relationCheckSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['code-coverage', 'spatial-overlap', 'same-crs']),
  leftAssetId: z.string().min(1),
  rightAssetId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'unknown']),
  facts: z.array(z.string()),
  missingValues: z.array(z.union([z.string(), z.number()])).optional(),
})

export const bindingStatusSchema = z.enum(['matched', 'ambiguous', 'missing', 'rejected'])

export const bindingDecisionSchema = z.object({
  slot: z.string().min(1),
  selectedAssetId: z.string().min(1).optional(),
  candidateAssetIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  status: bindingStatusSchema,
  facts: z.array(evidenceSchema),
  agentReasoning: z.string().min(1),
  userEvidence: z.array(evidenceSchema).optional(),
})

export const bindingReportSchema = z.object({
  taskSpecId: z.string().min(1),
  modelSchemaId: z.string().min(1),
  bindings: z.array(bindingDecisionSchema),
  relationChecks: z.array(relationCheckSchema),
  conflicts: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      relatedSlots: z.array(z.string()).default([]),
      relatedAssetIds: z.array(z.string()).default([]),
    }),
  ),
  unresolvedQuestions: z.array(z.string()),
  recommendedNextAction: z.enum([
    'request-user-input',
    'collect-more-evidence',
    'proceed-to-validation',
  ]),
})

export type DataCard = z.infer<typeof dataCardSchema>
export type InputSlot = z.infer<typeof inputSlotSchema>
export type ModelInputSchema = z.infer<typeof modelInputSchemaSchema>
export type Evidence = z.infer<typeof evidenceSchema>
export type Candidate = z.infer<typeof candidateSchema>
export type CandidateSet = z.infer<typeof candidateSetSchema>
export type RelationCheck = z.infer<typeof relationCheckSchema>
export type BindingDecision = z.infer<typeof bindingDecisionSchema>
export type BindingReport = z.infer<typeof bindingReportSchema>
