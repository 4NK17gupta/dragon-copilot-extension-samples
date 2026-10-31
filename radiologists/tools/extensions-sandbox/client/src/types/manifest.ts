export const CONTRACT_BASED = 'contractBased' as const;
export const PARTNER_INITIATED = 'partnerInitiated' as const;

export type ToolType = typeof CONTRACT_BASED | typeof PARTNER_INITIATED;

export const PRE_DRAFT_REPORT_GENERATION_CAPABILITY = 'preDraftReportGeneration' as const;
