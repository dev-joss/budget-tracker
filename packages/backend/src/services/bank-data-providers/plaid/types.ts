export interface PlaidCredentials {
  accessToken: string;
}

export interface PlaidConnectionMetadata {
  itemId: string;
  institutionId: string | null;
  institutionName: string;
  cursor: string | null;
  initialUpdateComplete?: boolean;
  historicalUpdateComplete?: boolean;
  repairWarning?: 'pending_disconnect' | 'pending_expiration' | null;
  deactivationReason?: string | null;
}
