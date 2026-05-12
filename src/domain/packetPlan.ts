export interface PacketPlanDIP {
  dipId: string;
  storyIds: string[];
  rationale: string;
}

export interface PacketPlan {
  packetPlan: PacketPlanDIP[];
}
