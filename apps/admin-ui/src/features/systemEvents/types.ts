export type SystemEvent = {
  id: number;
  type: string;
  entityType: string;
  entityId: string;
  message: string | null;
  payloadJson: unknown;
  processed: boolean;
  createdAt: string;
};

export type SecurityActivityResponse = {
  events: SystemEvent[];
};
