export type UserRole = 'admin' | 'coordinator' | 'mashgiach' | 'owner' | 'worker';

export interface UserPermissions {
  canFillTasks?: boolean; // Can complete, check off, and write notes on tasks
  canAssignTasks?: boolean; // Can add / create new assignments and edit tasks
}

export type TaskInputType = 'toggle' | 'yes_no' | 'status_select' | 'checkbox';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'yes' | 'no' | string;

export interface KosherAgency {
  id: string;
  name: string; // e.g. "Hartford Kashrut Commission (HKC)", "Chicago Rabbinical Council (cRc)"
  shortCode: string; // e.g. "HKC", "cRc"
  adminEmail: string; // primary administrator email
  certificationSeal: string; // e.g. "Glatt Kosher & Mehadrin Kashrut"
  region: string; // e.g. "Hartford, Connecticut & New England"
  contactPhone?: string;
  createdAt: string;
  venuesCount?: number;
  workersCount?: number;
}

export interface Venue {
  id: string;
  agencyId?: string; // Which kosher agency oversees this venue
  name: string;
  category: string;
  address?: string;
  certification?: string;
  ownerEmail?: string;
  createdAt: string;
  totalTasksToday?: number;
  completedTasksToday?: number;
  completionRate?: number;
  workerCount?: number;
}

export interface User {
  id: string;
  agencyId?: string; // Which kosher agency this user belongs to
  agencyName?: string; // Display name of user's kosher agency
  agencySeal?: string; // Rabbinical seal / kashrut standard of the agency
  agencyShortCode?: string; // Short code e.g. HKC, cRc
  email: string;
  name: string;
  role: UserRole;
  avatarColor?: string;
  venueId?: string; // Workers & Owners belong to a specific venue; Admins have access to all in their agency
  permissions?: UserPermissions;
}

export interface Task {
  id: string;
  agencyId?: string;
  venueId?: string;
  title: string;
  description: string;
  category: string;
  inputType: TaskInputType;
  customStatusOptions?: string[]; // Admin-defined options for status_select
  completedStatusValues?: string[]; // Which options count as completed
  assignedTo: string[]; // ['all'] or array of user emails ['alex@company.com']
  scheduleType?: 'recurring' | 'specific_dates'; // 'recurring' (days of week) or 'specific_dates' (calendar dates)
  daysOfWeek: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday. Empty = every day.
  specificDates?: string[]; // Array of 'YYYY-MM-DD' dates for one-time or specific date tasks
  targetTime?: string; // e.g. "09:00 AM", "14:00"
  priority?: 'low' | 'medium' | 'high';
  
  // Current Day's State
  currentStatus: TaskStatus;
  isCompleted: boolean;
  notes: string;
  updatedByEmail: string | null;
  updatedByName: string | null;
  updatedAt: string | null; // ISO string
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  date: string; // YYYY-MM-DD
  status: TaskStatus;
  isCompleted: boolean;
  notes: string;
  completedByEmail: string | null;
  completedByName: string | null;
  completedAt: string | null;
  category: string;
}

export interface DailySnapshot {
  id: string;
  agencyId?: string;
  venueId?: string;
  date: string; // YYYY-MM-DD
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  entries: HistoryEntry[];
  resetAt: string;
  resetBy: string; // 'system' or admin email
}

export interface DashboardStats {
  totalTasksToday: number;
  completedTasksToday: number;
  completionRate: number;
  myTasksCount: number;
  myCompletedCount: number;
  activeWorkersCount: number;
  currentDateFormatted: string;
}

export interface EventTask {
  id: string;
  title: string;
  description?: string;
  category?: string;
  isCompleted: boolean;
  completedAt?: string | null;
  completedByName?: string | null;
  completedByEmail?: string | null;
  notes?: string;
}

export interface ExternalMashgiach {
  name: string;
  phone: string;
  email: string;
}

export interface KosherEvent {
  id: string;
  agencyId: string;
  venueId: string;
  venueName?: string;
  title: string;
  location: string;
  date: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD (optional for multi-day)
  startTime?: string; // e.g. "17:00"
  endTime?: string; // e.g. "23:00"
  mashgiachType: 'assigned_user' | 'external' | 'unassigned';
  assignedMashgiachEmail?: string; // User email if from system
  assignedMashgiachName?: string;
  externalMashgiach?: ExternalMashgiach;
  menuAttachmentName?: string;
  menuAttachmentData?: string; // Data URL or text representation
  notes?: string;
  status: 'pending_review' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  tasks: EventTask[];
  createdByEmail: string;
  createdByName: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ServerBroadcastMessage {
  type: 
    | 'TASK_UPDATED' 
    | 'TASK_CREATED' 
    | 'TASK_DELETED' 
    | 'DAILY_RESET' 
    | 'INITIAL_STATE' 
    | 'USER_PRESENCE' 
    | 'USERS_UPDATED' 
    | 'VENUE_CREATED' 
    | 'VENUE_UPDATED' 
    | 'VENUE_DELETED' 
    | 'AGENCY_REGISTERED' 
    | 'AGENCY_UPDATED'
    | 'EVENT_CREATED'
    | 'EVENT_UPDATED'
    | 'EVENT_DELETED'
    | 'CLEAN_SLATE_RESET'
    | 'DEMO_RESTORED';
  payload: any;
  timestamp: string;
  senderEmail?: string;
  agencyId?: string;
  venueId?: string;
}
