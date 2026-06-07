import { z } from 'zod'
import { modelInputSchemaSchema, type InputSlot, type ModelInputSchema } from '../domain/schemas.ts'

const gsmsInputSchema = z.object({
  id: z.string().min(1),
  invest_arg: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  help: z.string().optional(),
  kind: z.string().optional(),
  asset_type: z.string().optional(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  required_if: z.string().optional(),
  semantic_terms: z.array(z.string()).optional(),
  required_fields: z.array(z.string()).optional(),
})

const gsmsRelationSchema = z.object({
  kind: z.enum(['code-coverage', 'spatial-overlap', 'same-crs']),
  left_slot: z.string().min(1),
  right_slot: z.string().min(1),
  field: z.string().optional(),
})

const gsmsModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  invest_version: z.string().optional(),
  inputs: z.array(gsmsInputSchema),
  matching_relations: z.array(gsmsRelationSchema).default([]),
})

function valueType(input: z.infer<typeof gsmsInputSchema>): InputSlot['valueType'] {
  if (input.kind === 'asset') {
    if (input.asset_type === 'table') return 'csv'
    if (input.asset_type === 'geojson') return 'vector'
    if (input.asset_type === 'raster') return 'raster'
  }
  if (input.kind === 'boolean') return 'boolean'
  if (input.kind === 'number') return 'number'
  return 'string'
}

function semanticTerms(input: z.infer<typeof gsmsInputSchema>): string[] {
  if (input.semantic_terms?.length) return input.semantic_terms
  return [input.label, input.help]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter(term => term.length > 2)
}

export function adaptGsmsModelSchema(raw: unknown): ModelInputSchema {
  const source = gsmsModelSchema.parse(raw)
  const slots = source.inputs
    .filter(input => input.kind === 'asset')
    .map(input => {
      const name = input.invest_arg ?? input.id
      return {
        name,
        required: input.required === true,
        valueType: valueType(input),
        semanticRole: input.label ?? name,
        semanticTerms: semanticTerms(input),
        requiredFields: input.required_fields ?? [],
        relationConstraints: source.matching_relations
          .filter(relation => relation.left_slot === name)
          .map(relation => ({
            kind: relation.kind,
            otherSlot: relation.right_slot,
            field: relation.field,
          })),
      }
    })
  return modelInputSchemaSchema.parse({
    modelId: source.id,
    displayName: source.name,
    version: source.invest_version ?? source.version ?? 'runtime',
    slots,
  })
}
