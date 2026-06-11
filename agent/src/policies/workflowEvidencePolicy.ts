export interface WorkflowEvidenceInstructionInput {
  phase: string
  modelId: string
  counts: Readonly<Record<string, number | undefined>>
  missingRequiredSlots?: readonly string[]
  pendingImportFileIds?: readonly string[]
  dataAvailabilityInstruction?: string
  phaseResumeInstruction?: (phase: string, modelId: string) => string | undefined
}

export function workflowEvidenceInstruction(input: WorkflowEvidenceInstructionInput): string {
  const { phase, modelId, counts } = input
  if (phase === 'awaiting-data-import-confirmation') {
    const fileIds = input.pendingImportFileIds ?? []
    return fileIds.length
      ? `Call import_data_hub_files_to_scene with fileIds ${fileIds.join(', ')} for model "${modelId}" so the permission system can ask the user to confirm importing Data Hub references. Do not finish with a plain-text confirmation question.`
      : 'A Data Hub import proposal exists. Call import_data_hub_files_to_scene with the proposed file IDs so the permission system can request user confirmation; do not finish with a plain-text confirmation question.'
  }

  const phaseInstruction = input.phaseResumeInstruction?.(phase, modelId)
  if (phaseInstruction && (phase !== 'ready-for-validation' || counts['binding-report'])) {
    return phaseInstruction
  }

  if (phase === 'matching-slots' && counts['candidate-set']) {
    const missing = input.missingRequiredSlots ?? []
    if (missing.length) {
      return `Retrieve candidates for these required slots before finalizing: ${missing.join(', ')}. Prefer one call to retrieve_required_input_candidates for model "${modelId}" instead of parallel per-slot calls.`
    }
    return 'Reuse the persisted candidate sets and relation checks, then call finalize_data_matching. Do not construct a Binding Report manually.'
  }

  if (phase === 'sufficiency-assessed') {
    return 'Sufficiency assessment is complete. Call finish with the report findings.'
  }

  if (phase === 'validation-failed') {
    return 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.'
  }

  if (phase === 'discovering-data' || phase === 'matching-slots') {
    if (input.dataAvailabilityInstruction) return input.dataAvailabilityInstruction

    const hasSchema = Boolean(counts['model-input-schema'])
    const hasDataCards = Boolean(counts['gsms-scene-data-cards'])
    const hasCandidates = Boolean(counts['candidate-set'])
    const hasSufficiencyReport = Boolean(counts['sufficiency-report'])
    const hasBindingReport = Boolean(counts['binding-report'])

    if (hasSufficiencyReport || hasBindingReport) {
      return 'Assessment or matching complete. Call finish with the findings.'
    }
    if (hasSchema && hasDataCards && hasCandidates) {
      return 'Schema, data cards, and candidates are loaded. If assessing sufficiency, call finalize_sufficiency_assessment. If matching, call finalize_data_matching.'
    }
    if (hasSchema && hasDataCards) {
      return `Schema and data cards loaded. Call retrieve_required_input_candidates once for model "${modelId}" to check all required slots. Do not invent *_asset_id slot names and do not call retrieve_input_candidates in parallel.`
    }
    if (hasDataCards) {
      return 'Data cards loaded. Call get_invest_model_schema for the target model, then retrieve_required_input_candidates once.'
    }
    if (hasSchema) {
      return 'Schema loaded. Call list_scene_data_cards to load scene data, then retrieve_required_input_candidates once.'
    }
    return 'Start by calling list_scene_data_cards and/or get_invest_model_schema to gather evidence.'
  }

  return 'If the user question is answered by available evidence, call finish. Otherwise continue gathering evidence.'
}
