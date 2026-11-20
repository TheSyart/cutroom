export type OptionalCapabilityId = 'watchlist' | 'computer_use'

export interface OptionalCapabilityPortfolioEntry {
  readonly id: OptionalCapabilityId
  readonly owner: string
  readonly status: 'active' | 'evaluation_gated'
  readonly defaultMode: 'off' | 'available'
  readonly userEntry: string
  readonly dataAuthority: string
  readonly evaluation: {
    readonly command: string
    readonly receiptRequiredForMutation: boolean
  }
  readonly maintenance: {
    readonly budget: 'low' | 'medium' | 'high'
    readonly suite: string
  }
  readonly nextReviewOn: string
  readonly retireCriteria: readonly string[]
}
