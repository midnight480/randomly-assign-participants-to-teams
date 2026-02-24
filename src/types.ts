export interface TeamSlot {
  name: string;
  size: number;
}

export interface EventPattern {
  teams: TeamSlot[];
}

export interface EventRow {
  id: number;
  event_code: string;
  title: string;
  pattern_json: string;
  admin_token_hash: string;
  created_at: string;
}

export interface ParticipantRow {
  id: number;
  event_id: number;
  display_name: string;
  created_at: string;
}

export interface AssignmentRow {
  id: number;
  event_id: number;
  participant_id: number;
  team_name: string;
  assigned_at: string;
}

export interface TeamStatus {
  name: string;
  size: number;
  assigned: number;
  remaining: number;
  members: string[];
}

export interface EventResponse {
  event_code: string;
  title: string;
  pattern: EventPattern;
  teams: TeamStatus[];
  total_slots: number;
  assigned_count: number;
  unassigned_count: number;
  remaining_slots: number;
}
