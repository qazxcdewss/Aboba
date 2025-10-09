export interface AuthPublicService {
  getSessionUser(req: unknown): Promise<{ userId: string } | null>;
  ensureRole(user: { userId: string }, role: 'moderator' | 'admin'): void;
  audit(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ProfilesPublicService {
  markPublishable(profileId: string, decidedBy?: string): Promise<void>;
  markNeedsFix(profileId: string, notes?: string): Promise<void>;
  markRejected(profileId: string, reason?: string): Promise<void>;
  publishFromOrder(
    profileId: string,
    orderId: string,
    startsAt: Date,
    expiresAt: Date,
  ): Promise<void>;
  isReadyToSubmit(profileId: string): Promise<{ ok: boolean; reasons?: string[] }>;
}

export interface MediaPublicService {
  createPhotoRecord(
    profileId: string,
    storageKey: string,
    meta: { sha256: string; size: number; width?: number; height?: number },
  ): Promise<{ photoId: string }>;
  setCover(profileId: string, photoId: string): Promise<void>;
  reorder(profileId: string, photoId: string, orderIndex: number): Promise<void>;
}

export interface ModerationPublicService {
  createTask(input: {
    profileId: string;
    kind: 'profile_full' | 'photo' | 'video';
    targetPhotoId?: string;
    targetVideoId?: string;
    aiScore?: number;
    aiPayload?: unknown;
  }): Promise<{ taskId: string }>;
  applyDecision(input: {
    taskId: string;
    decision: 'approved' | 'needs_fix' | 'rejected';
    reasonCode?: string;
    notes?: string;
    decidedByTelegramUserId?: string;
  }): Promise<void>;
}

export interface BillingPublicService {
  createInvoice(
    userId: string,
    asset: string,
  ): Promise<{ invoiceId: string; address: string; memo?: string; exactAmount: string }>;
  getBalance(userId: string): Promise<Array<{ currency: string; amountMinor: number }>>;
  createPublicationOrder(
    userId: string,
    profileId: string,
    periodDays: number,
  ): Promise<{ orderId: string; priceMinor: number; currency: string }>;
  payPublicationOrder(userId: string, orderId: string, idemKey: string): Promise<void>;
}
