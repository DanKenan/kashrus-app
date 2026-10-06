import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const app = express();
const server = http.createServer(app);

app.use(express.json());

// In-memory + file-backed storage
interface Agency {
  id: string;
  name: string;
  shortCode: string;
  adminEmail: string;
  certificationSeal: string;
  region: string;
  contactPhone?: string;
  createdAt: string;
}

interface Venue {
  id: string;
  agencyId: string;
  name: string;
  category: string;
  address: string;
  certification: string;
  ownerEmail?: string;
  createdAt: string;
}

interface TaskItem {
  id: string;
  agencyId?: string;
  venueId: string;
  title: string;
  description: string;
  category: string;
  inputType: 'toggle' | 'yes_no' | 'status_select' | 'checkbox';
  customStatusOptions?: string[];
  completedStatusValues?: string[];
  assignedTo: string[]; // ['all'] or array of worker emails
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek: number[]; // 0-6
  specificDates?: string[]; // 'YYYY-MM-DD'
  targetTime?: string;
  priority?: 'low' | 'medium' | 'high';
  currentStatus: string;
  isCompleted: boolean;
  notes: string;
  updatedByEmail: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  createdAt: string;
}

interface HistoryLog {
  id: string;
  agencyId?: string;
  venueId: string;
  date: string;
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  entries: Array<{
    id: string;
    taskId: string;
    taskTitle: string;
    category: string;
    status: string;
    isCompleted: boolean;
    notes: string;
    completedByEmail: string | null;
    completedByName: string | null;
    completedAt: string | null;
  }>;
  resetAt: string;
  resetBy: string;
}

export interface UserPermissions {
  canFillTasks?: boolean;
  canAssignTasks?: boolean;
}

export interface EventTaskItem {
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

export interface ExternalMashgiachInfo {
  name: string;
  phone: string;
  email: string;
}

export interface KosherEventItem {
  id: string;
  agencyId: string;
  venueId: string;
  venueName?: string;
  title: string;
  location: string;
  date: string; // YYYY-MM-DD
  endDate?: string;
  startTime?: string;
  endTime?: string;
  mashgiachType: 'assigned_user' | 'external' | 'unassigned';
  assignedMashgiachEmail?: string;
  assignedMashgiachName?: string;
  externalMashgiach?: ExternalMashgiachInfo;
  menuAttachmentName?: string;
  menuAttachmentData?: string;
  notes?: string;
  status: 'pending_review' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  tasks: EventTaskItem[];
  createdByEmail: string;
  createdByName: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AirtableConfigItem {
  id?: string;
  agencyId: string;
  venueId?: string; // Venue/factory specific or agency-wide
  apiKey?: string; // Airtable Personal Access Token (pat...)
  baseId: string; // app...
  tableName: string; // e.g. "Approved Ingredients"
  viewName?: string; // e.g. "Grid view"
  fieldNameMapping?: {
    ingredientName?: string;
    brandOrSupplier?: string;
    kashrutAgency?: string;
    kosherStatus?: string;
    lotNumber?: string;
    approvalDate?: string;
    approvedBy?: string;
    factoryFacility?: string;
    notes?: string;
    status?: string;
  };
  lastSyncedAt?: string;
  autoSyncEnabled?: boolean;
}

export interface ApprovedIngredientItem {
  id: string;
  airtableRecordId?: string;
  venueId: string;
  agencyId: string;
  name: string;
  brandOrSupplier?: string;
  kashrutAgency?: string;
  kosherStatus: 'Parve' | 'Dairy' | 'Meat' | 'Cholov Yisroel' | 'Pas Yisroel' | 'Glatt' | 'Other';
  lotOrBatch?: string;
  approvalStatus: 'approved' | 'pending_approval' | 'discontinued' | 'flagged';
  approvalDate?: string;
  approvedBy?: string;
  notes?: string;
  verificationStatus?: 'verified_present' | 'verified_not_found' | 'unverified' | 'flagged_discrepancy';
  verifiedAt?: string | null;
  verifiedByName?: string | null;
  verifiedByEmail?: string | null;
  verificationNotes?: string;
}

export interface UnapprovedDiscrepancyItem {
  id: string;
  name: string;
  brandOrSupplier?: string;
  kashrutSymbolFound?: string;
  lotOrBatch?: string;
  locationInFactory?: string;
  severity: 'critical' | 'warning' | 'inquiry';
  notes: string;
  actionTaken?: string;
  photoUrl?: string;
  reportedAt: string;
  reportedByName: string;
  reportedByEmail: string;
}

export interface FactoryAuditReportItem {
  id: string;
  agencyId: string;
  venueId: string;
  venueName?: string;
  auditDate: string; // YYYY-MM-DD
  startTime?: string;
  endTime?: string;
  mashgiachName: string;
  mashgiachEmail: string;
  factoryRepresentative?: string;
  totalApprovedChecked: number;
  totalPresent: number;
  totalDiscrepancies: number;
  auditedIngredients: Array<{
    ingredientId: string;
    name: string;
    brandOrSupplier?: string;
    status: 'verified_present' | 'verified_not_found' | 'flagged_discrepancy';
    notes?: string;
  }>;
  discrepancies: UnapprovedDiscrepancyItem[];
  summaryNotes: string;
  status: 'passed' | 'passed_with_notes' | 'critical_violation_found' | 'in_progress';
  mashgiachSigned: boolean;
  signatureTimestamp?: string;
  createdAt: string;
}

interface UserProfile {
  id: string;
  agencyId?: string;
  email: string;
  name: string;
  role: 'admin' | 'coordinator' | 'mashgiach' | 'owner' | 'worker';
  avatarColor: string;
  password?: string;
  venueId?: string; // Mashgichim, Coordinators and Owners belong to a specific venue; Admins have access to all in their agency
  permissions?: UserPermissions;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_AGENCIES: Agency[] = [
  {
    id: 'agency-hkc',
    name: 'Hartford Kashrut Commission (HKC)',
    shortCode: 'HKC',
    adminEmail: 'kenan@hartfordkashrut.org',
    certificationSeal: 'Hartford Kashrut Commission (HKC) - Glatt Meat & Mehadrin',
    region: 'Hartford, CT & New England',
    contactPhone: '(860) 236-1241',
    createdAt: new Date(Date.now() - 90 * 86400000).toISOString(),
  },
];

const DEFAULT_VENUES: Venue[] = [
  {
    id: 'venue-crown-market',
    agencyId: 'agency-hkc',
    name: 'Crown Market & Deli',
    category: 'Restaurant & Deli',
    address: '2471 Albany Ave, West Hartford, CT',
    certification: 'Hartford Kashrut Commission (HKC) - Glatt Meat & Parve',
    ownerEmail: 'owner@kosherkitchen.com',
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
  },
  {
    id: 'venue-hartford-bakery',
    agencyId: 'agency-hkc',
    name: 'Shalom Kosher Bakery & Cafe',
    category: 'Bakery & Cafe',
    address: '1122 Boulevard, West Hartford, CT',
    certification: 'Hartford Kashrut Commission (HKC) - Pas Yisroel & Cholov Yisroel',
    ownerEmail: 'owner.bakery@kosherkitchen.com',
    createdAt: new Date(Date.now() - 14 * 86400000).toISOString(),
  },
  {
    id: 'venue-chabad-catering',
    agencyId: 'agency-hkc',
    name: 'Simcha Kosher Caterers',
    category: 'Catering & Events',
    address: '2352 Albany Ave, West Hartford, CT',
    certification: 'Hartford Kashrut Commission (HKC) - Mehadrin Catering',
    ownerEmail: 'owner.catering@kosherkitchen.com',
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  },
  {
    id: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'New England Kosher Foods Factory (Industrial)',
    category: 'Industrial / Manufacturing Plant',
    address: '45 Industrial Park Rd, Hartford, CT',
    certification: 'Hartford Kashrut Commission (HKC) - Industrial Kosher Supervision',
    ownerEmail: 'qa@ne-kosherfoods.com',
    createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
  },
];

const DEFAULT_USERS: UserProfile[] = [
  { id: 'usr_admin', agencyId: 'agency-hkc', email: 'kenan@hartfordkashrut.org', name: 'Kenan (Admin)', role: 'admin', avatarColor: '#3b82f6', password: 'Kosher2026!' },
];

function generateTemplateTasks(venueId: string, templateType: string = 'restaurant', agencyId: string = 'agency-hkc'): TaskItem[] {
  const now = new Date().toISOString();
  if (templateType === 'bakery') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Morning Pas Yisroel Heating Element Inspection',
        description: 'Verify Mashgiach or Jewish owner energized the primary baking ovens and pilot ignition switches.',
        category: 'Pas Yisroel',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '06:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Flour Sifting Log (Kashrut Insect Infestation Control)',
        description: 'Sift 50lb flour bags through 70-mesh electric sifter screen. Inspect mesh under lightbox before production.',
        category: 'Ingredient Inspection',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'Inspected & Clear', 'Flagged / Debris Found', 'Completed'],
        completedStatusValues: ['Inspected & Clear', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '07:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Dairy / Parve Equipment & Baking Sheet Separation',
        description: 'Ensure blue-coded trays remain dedicated strictly to Parve breads; red trays for Cholov Yisroel pastries.',
        category: 'Kashrut Segregation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '09:00 AM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Proofer & Walk-in Retarder Temperature Verification',
        description: 'Verify dough proofer humidity (80-85%) and temperature (95°F - 100°F). Retarder at 36°F.',
        category: 'Food Safety',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '11:00 AM',
        priority: 'medium',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-5`,
        venueId,
        title: 'Affix Kosher Certification Stickers to Packaged Goods',
        description: 'Seal all retail pastry boxes and bread bags with tamper-evident Hartford Kashrut certification hologram labels.',
        category: 'Packaging & Seals',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '15:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'catering') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Inspect Kosher Mashgiach Tamper Tape & Box Seals',
        description: 'Confirm all insulated transport carriers and Cambro boxes retain intact stamped red seal tape before transit.',
        category: 'Kashrut Security',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '08:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Hot Holding Transport Box Temperature Log (Min 140°F)',
        description: 'Probe internal core temperatures of transport cambros prior to leaving commissary kitchen.',
        category: 'Food Safety',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'Logged > 140°F Compliant', 'Reheated Required', 'Completed'],
        completedStatusValues: ['Logged > 140°F Compliant', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '11:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Segregate Meat vs Dairy Event Flatware & Serving Pieces',
        description: 'Double check color bands on chaffing dishes and serving tongs at venue staging area.',
        category: 'Kashrut Segregation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '13:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Post-Event Sealed Kosher Food Return Manifest',
        description: 'Reseal unopened kosher pans with signature tape and record return inventory count.',
        category: 'Logistics',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '22:00 PM',
        priority: 'medium',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'industrial') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Factory Raw Material Intake & Kosher Certificate Audit',
        description: 'Verify incoming bulk totes, drums, and dry sacks against the agency-approved Airtable ingredient matrix. Inspect kosher letters of certification (LoC) validity.',
        category: 'Ingredient Verification',
        inputType: 'status_select',
        customStatusOptions: ['Pending Verification', 'All Raw Materials Approved', 'Unapproved Item Quarantined', 'Completed'],
        completedStatusValues: ['All Raw Materials Approved', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '08:30 AM',
        priority: 'high',
        currentStatus: 'Pending Verification',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Factory Floor Physical Walkthrough & Unapproved Ingredient Audit',
        description: 'Check active production lines, staging racks, flavoring shelves, and blending kettles. Ensure no unauthorized sub-ingredients or undocumented processing aids are present on-site.',
        category: 'Factory Floor Audit',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '10:30 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'CIP (Clean-In-Place) & Kosher Steam Line Temperature Check',
        description: 'Confirm clean-in-place chemical wash cycle and boiling water / live steam purge reached 212°F on continuous pasteurizer before kosher batch start.',
        category: 'Equipment Kosherization',
        inputType: 'status_select',
        customStatusOptions: ['Pending Clean', 'CIP Complete (>212°F Verified)', 'Sanitization Failed', 'Completed'],
        completedStatusValues: ['CIP Complete (>212°F Verified)', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '13:00 PM',
        priority: 'high',
        currentStatus: 'Pending Clean',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Submit Factory Mashgiach Ingredient Inspection Report',
        description: 'Complete the factory inspection report summarizing approved ingredients verified, unauthorized discrepancies flagged, and signed off with QA.',
        category: 'Audit & Compliance',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '16:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'blank') {
    return [];
  } else {
    // Standard Restaurant / Deli template
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Check Morning Deliveries & Kosher Supplier Invoices',
        description: 'Inspect pallets at loading dock, match bills of lading with kosher certified vendor list, and verify hashgacha seals.',
        category: 'Logistics',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '09:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Refrigeration & Freezer Temperature Logs',
        description: 'Log digital readings for Walk-in Coolers 1-3 (must be between 34°F - 38°F) and Freezer units (-5°F - 0°F).',
        category: 'Food Safety',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'In Progress', 'Blocked', 'Completed'],
        completedStatusValues: ['Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '10:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Sanitize Workstations & Meat/Dairy Separation Lines',
        description: 'Clean stainless steel preparation tables with approved sanitizing agent, replenish towels, and inspect kosher wash sinks.',
        category: 'Sanitation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '13:00 PM',
        priority: 'medium',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Audit Raw Ingredient Expiration Dates & Kosher Symbols',
        description: 'Cross-check labels on dairy/meat shelves, remove expired stock, and ensure all packaging has approved kosher hechsher.',
        category: 'Quality Assurance',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [1, 3, 5],
        targetTime: '14:30 PM',
        priority: 'medium',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-5`,
        venueId,
        title: 'End of Shift Equipment Lockout & Gas Valve Shutoff',
        description: 'Ensure heat sealers, fryers, and cooktops are disengaged, gas valves shut, and locks secured.',
        category: 'Operations',
        inputType: 'toggle',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '17:30 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  }
}

function getSafeUser(user: UserProfile) {
  const { password, ...safe } = user;
  const userAgency = agencies.find((a) => a.id === user.agencyId) || agencies[0];
  return {
    ...safe,
    agencyName: userAgency?.name || 'Kosher Supervision Agency',
    agencySeal: userAgency?.certificationSeal || 'Certified Kosher',
    agencyShortCode: userAgency?.shortCode || 'HKC',
  };
}

function getSafeUsers() {
  return users.map(getSafeUser);
}

const INITIAL_TASKS: TaskItem[] = [
  {
    id: 'task-1',
    venueId: 'venue-crown-market',
    title: 'Check Morning Deliveries & Supplier Invoices',
    description: 'Inspect pallets at loading dock B, match bills of lading with purchase orders, and verify temperature seals.',
    category: 'Logistics',
    inputType: 'yes_no',
    assignedTo: ['all'],
    daysOfWeek: [1, 2, 3, 4, 5],
    targetTime: '09:00 AM',
    priority: 'high',
    currentStatus: 'yes',
    isCompleted: true,
    notes: 'All 4 pallets arrived on time from Sysco. Seal integrity confirmed by dock supervisor.',
    updatedByEmail: 'alex@company.com',
    updatedByName: 'Alex Rivera',
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    createdAt: new Date().toISOString(),
  },
  {
    id: 'task-2',
    venueId: 'venue-crown-market',
    title: 'Refrigeration & Freezer Temperature Logs',
    description: 'Log digital readings for Walk-in Coolers 1-3 (must be between 34°F - 38°F) and Freezer units (-5°F - 0°F).',
    category: 'Food Safety',
    inputType: 'status_select',
    assignedTo: ['maria@company.com'],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetTime: '10:30 AM',
    priority: 'high',
    currentStatus: 'completed',
    isCompleted: true,
    notes: 'Cooler 1: 36.2°F, Cooler 2: 35.8°F, Freezer: -2.1°F. All within compliant range.',
    updatedByEmail: 'maria@company.com',
    updatedByName: 'Maria Santos',
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
    createdAt: new Date().toISOString(),
  },
  {
    id: 'task-3',
    venueId: 'venue-crown-market',
    title: 'Sanitize Workstations & Assembly Lines',
    description: 'Clean stainless steel preparation tables with approved sanitizing agent, replenish paper towels, and empty rinse buckets.',
    category: 'Sanitation',
    inputType: 'checkbox',
    assignedTo: ['all'],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetTime: '13:00 PM',
    priority: 'medium',
    currentStatus: 'pending',
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'task-4',
    venueId: 'venue-crown-market',
    title: 'Audit Raw Ingredient Expiration Dates',
    description: 'Check batch stickers on shelving racks 4 through 8. Apply FIFO (First In, First Out) rotation and flag items within 48h of expiration.',
    category: 'Inventory',
    inputType: 'yes_no',
    assignedTo: ['david@company.com'],
    daysOfWeek: [1, 3, 5],
    targetTime: '14:30 PM',
    priority: 'medium',
    currentStatus: 'no',
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'task-5',
    venueId: 'venue-crown-market',
    title: 'End of Shift Equipment Lockout & Power Down',
    description: 'Ensure heat sealers, conveyor belts, and pneumatic lines are disengaged and power isolators locked in the OFF position.',
    category: 'Operations',
    inputType: 'toggle',
    assignedTo: ['all'],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetTime: '17:30 PM',
    priority: 'high',
    currentStatus: 'pending',
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'task-6',
    venueId: 'venue-crown-market',
    title: 'Facility Perimeter & Security Alarm Check',
    description: 'Verify side emergency exit doors are latched from exterior, arm motion sensor zone 2, and sign departure log at main guard gate.',
    category: 'Security',
    inputType: 'toggle',
    assignedTo: ['kenan@hartfordkashrut.org', 'alex@company.com'],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetTime: '18:00 PM',
    priority: 'high',
    currentStatus: 'pending',
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    createdAt: new Date().toISOString(),
  },
  // Add starter tasks for Bakery
  ...generateTemplateTasks('venue-hartford-bakery', 'bakery'),
  // Add starter tasks for Catering
  ...generateTemplateTasks('venue-chabad-catering', 'catering'),
];

const INITIAL_HISTORY: HistoryLog[] = [
  {
    id: 'hist-yesterday',
    venueId: 'venue-crown-market',
    date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
    totalTasks: 6,
    completedTasks: 6,
    completionRate: 100,
    resetAt: new Date(Date.now() - 86400000).toISOString(),
    resetBy: 'system',
    entries: [
      {
        id: 'h-1',
        taskId: 'task-1',
        taskTitle: 'Check Morning Deliveries & Supplier Invoices',
        category: 'Logistics',
        status: 'yes',
        isCompleted: true,
        notes: 'Signed for 3 deliveries. Minor dent on outer box carton #4, interior intact.',
        completedByEmail: 'alex@company.com',
        completedByName: 'Alex Rivera',
        completedAt: new Date(Date.now() - 86400000 + 3600000).toISOString(),
      },
      {
        id: 'h-2',
        taskId: 'task-2',
        taskTitle: 'Refrigeration & Freezer Temperature Logs',
        category: 'Food Safety',
        status: 'completed',
        isCompleted: true,
        notes: 'All units stable. 35.5°F and -3°F.',
        completedByEmail: 'maria@company.com',
        completedByName: 'Maria Santos',
        completedAt: new Date(Date.now() - 86400000 + 7200000).toISOString(),
      },
      {
        id: 'h-3',
        taskId: 'task-3',
        taskTitle: 'Sanitize Workstations & Assembly Lines',
        category: 'Sanitation',
        status: 'completed',
        isCompleted: true,
        notes: 'Completed full sanitization spray and wiped down lines 1 & 2.',
        completedByEmail: 'david@company.com',
        completedByName: 'David Chen',
        completedAt: new Date(Date.now() - 86400000 + 10800000).toISOString(),
      },
      {
        id: 'h-4',
        taskId: 'task-4',
        taskTitle: 'Audit Raw Ingredient Expiration Dates',
        category: 'Inventory',
        status: 'yes',
        isCompleted: true,
        notes: 'No expired items found.',
        completedByEmail: 'david@company.com',
        completedByName: 'David Chen',
        completedAt: new Date(Date.now() - 86400000 + 14400000).toISOString(),
      },
      {
        id: 'h-5',
        taskId: 'task-5',
        taskTitle: 'End of Shift Equipment Lockout & Power Down',
        category: 'Operations',
        status: 'completed',
        isCompleted: true,
        notes: 'All breakers tagged and safely shut off.',
        completedByEmail: 'alex@company.com',
        completedByName: 'Alex Rivera',
        completedAt: new Date(Date.now() - 86400000 + 18000000).toISOString(),
      },
      {
        id: 'h-6',
        taskId: 'task-6',
        taskTitle: 'Facility Perimeter & Security Alarm Check',
        category: 'Security',
        status: 'completed',
        isCompleted: true,
        notes: 'All doors locked, alarm armed.',
        completedByEmail: 'kenan@hartfordkashrut.org',
        completedByName: 'Kenan (Admin)',
        completedAt: new Date(Date.now() - 86400000 + 20000000).toISOString(),
      },
    ],
  },
];

let agencies: Agency[] = [...DEFAULT_AGENCIES];
let venues: Venue[] = [...DEFAULT_VENUES];
let tasks: TaskItem[] = [...INITIAL_TASKS];
let historyLogs: HistoryLog[] = [...INITIAL_HISTORY];
let users: UserProfile[] = [...DEFAULT_USERS];
let currentWorkDate = new Date().toISOString().split('T')[0];
let isDemoCleared = false;

const INITIAL_EVENTS: KosherEventItem[] = [
  {
    id: 'evt-1',
    agencyId: 'agency-hkc',
    venueId: 'venue-crown-market',
    venueName: 'The Crown Market & Cafe',
    title: 'Congregation Beth El Bar Mitzvah Luncheon',
    location: 'Beth El Ballroom, 2626 Albany Ave, West Hartford, CT',
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    startTime: '11:30 AM',
    endTime: '15:30 PM',
    mashgiachType: 'assigned_user',
    assignedMashgiachEmail: 'alex@company.com',
    assignedMashgiachName: 'Alex Rivera (Mashgiach)',
    menuAttachmentName: 'Shabbat_Lunch_Meat_Menu.pdf',
    notes: 'Glatt Meat buffet, pre-sliced roast beef, pareve dessert buffet. Requires checking seal on Cambro warmers before unloading.',
    status: 'confirmed',
    tasks: [
      {
        id: 'etask-1',
        title: 'Inspect Tamper-Evident Delivery Seals on Cambro Warmers',
        description: 'Ensure serial-numbered blue HKC tape on all 4 hot transport boxes is intact.',
        category: 'Delivery',
        isCompleted: true,
        completedAt: new Date().toISOString(),
        completedByName: 'Alex Rivera (Mashgiach)',
        completedByEmail: 'alex@company.com',
        notes: 'All 4 seals matched manifest #4492.',
      },
      {
        id: 'etask-2',
        title: 'Oven Relighting / Pilot Ignition Check (Bishul Yisroel)',
        description: 'Mashgiach must verify ballroom secondary warming ovens ignited according to Bishul Yisroel standard.',
        category: 'Bishul Yisroel',
        isCompleted: false,
        notes: '',
      },
      {
        id: 'etask-3',
        title: 'Post-Event Meat/Parve Segregation & Utensil Packing',
        description: 'Ensure meat serving platters are crate-sealed and clearly separated from parve serving tongs.',
        category: 'Post-Event Wrapup',
        isCompleted: false,
        notes: '',
      },
    ],
    createdByEmail: 'owner@kosherkitchen.com',
    createdByName: 'Crown Market Owner',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
];

let events: KosherEventItem[] = [...INITIAL_EVENTS];

const INITIAL_AIRTABLE_CONFIGS: AirtableConfigItem[] = [
  {
    id: 'atcfg-hartford-manufacturing',
    agencyId: 'agency-hkc',
    venueId: 'venue-hartford-manufacturing',
    apiKey: '',
    baseId: 'appFactoryIngredientsDemo',
    tableName: 'Approved Ingredients',
    viewName: 'Grid view',
    fieldNameMapping: {
      ingredientName: 'Ingredient Name',
      brandOrSupplier: 'Manufacturer / Supplier',
      kashrutAgency: 'Kosher Certification Body',
      kosherStatus: 'Kosher Designation',
      lotNumber: 'Lot / Batch Number',
      approvalDate: 'Approval Date',
      approvedBy: 'Rabbinic Approver',
      status: 'Status',
      notes: 'Mashgiach Notes',
    },
    lastSyncedAt: new Date().toISOString(),
    autoSyncEnabled: true,
  },
];

const INITIAL_APPROVED_INGREDIENTS: ApprovedIngredientItem[] = [
  {
    id: 'ing-1',
    airtableRecordId: 'rec_at_corn_syrup_01',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'High Fructose Corn Syrup 55%',
    brandOrSupplier: 'Archer Daniels Midland (ADM)',
    kashrutAgency: 'OU (Orthodox Union)',
    kosherStatus: 'Parve',
    lotOrBatch: 'LOT-2026-ADM-994',
    approvalStatus: 'approved',
    approvalDate: '2026-01-15',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'Bulk railcar shipment; verify tamper-evident dome seal before intake into Tank #4.',
    verificationStatus: 'verified_present',
    verifiedAt: new Date().toISOString(),
    verifiedByName: 'Rabbi Shimon Klein (Factory Mashgiach)',
    verifiedByEmail: 'factory.mashgiach@hartfordkashrut.org',
    verificationNotes: 'Dome seal #8841 verified on railcar intake.',
  },
  {
    id: 'ing-2',
    airtableRecordId: 'rec_at_cocoa_butter_02',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'Deodorized Pure Cocoa Butter (Press Cake)',
    brandOrSupplier: 'Barry Callebaut USA',
    kashrutAgency: 'OK Kosher Certification',
    kosherStatus: 'Parve',
    lotOrBatch: 'BC-CB-4401',
    approvalStatus: 'approved',
    approvalDate: '2026-02-01',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'Designated for Parve line. Double-check kosher symbol on 25kg blocks.',
    verificationStatus: 'verified_present',
    verifiedAt: new Date().toISOString(),
    verifiedByName: 'Rabbi Shimon Klein (Factory Mashgiach)',
    verifiedByEmail: 'factory.mashgiach@hartfordkashrut.org',
    verificationNotes: 'Stored in climate-controlled bay 3.',
  },
  {
    id: 'ing-3',
    airtableRecordId: 'rec_at_lecithin_03',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'Non-GMO Sunflower Lecithin (Liquid Emulsifier)',
    brandOrSupplier: 'Cargill Food Ingredients',
    kashrutAgency: 'Star-K Kosher Certification',
    kosherStatus: 'Parve',
    lotOrBatch: 'SL-8832-CARG',
    approvalStatus: 'approved',
    approvalDate: '2026-03-10',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'Parve production run emulsifier.',
    verificationStatus: 'unverified',
    verificationNotes: '',
  },
  {
    id: 'ing-4',
    airtableRecordId: 'rec_at_whey_isolate_04',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'Sweet Whey Powder 90% Isolate (Cholov Yisroel)',
    brandOrSupplier: 'Glanbia Nutritionals',
    kashrutAgency: 'cRc (Chicago Rabbinical Council)',
    kosherStatus: 'Cholov Yisroel',
    lotOrBatch: 'GN-CY-1092',
    approvalStatus: 'approved',
    approvalDate: '2026-04-12',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'DAIRY LINE ONLY. Must be quarantined from Parve mixing vessel #2.',
    verificationStatus: 'unverified',
    verificationNotes: '',
  },
  {
    id: 'ing-5',
    airtableRecordId: 'rec_at_vanilla_extract_05',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'Pure Bourbon Vanilla Extract 2-Fold (Alcohol Ethyl Grain)',
    brandOrSupplier: 'Nielsen-Massey Vanillas',
    kashrutAgency: 'cRc & Star-K',
    kosherStatus: 'Parve',
    lotOrBatch: 'NM-VB-771',
    approvalStatus: 'approved',
    approvalDate: '2026-05-18',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'Ensure grain alcohol certificate is attached; Passover certification not included.',
    verificationStatus: 'unverified',
    verificationNotes: '',
  },
  {
    id: 'ing-6',
    airtableRecordId: 'rec_at_citric_acid_06',
    venueId: 'venue-hartford-manufacturing',
    agencyId: 'agency-hkc',
    name: 'Citric Acid Anhydrous USP Granular',
    brandOrSupplier: 'Jungbunzlauer Inc.',
    kashrutAgency: 'OU (Orthodox Union)',
    kosherStatus: 'Parve',
    lotOrBatch: 'JB-CA-5590',
    approvalStatus: 'approved',
    approvalDate: '2026-06-01',
    approvedBy: 'Rabbi Moshe Fein (HKC Kashrut Admin)',
    notes: 'Acidulant for fruit confection lines.',
    verificationStatus: 'unverified',
    verificationNotes: '',
  },
];

let airtableConfigs: AirtableConfigItem[] = [...INITIAL_AIRTABLE_CONFIGS];
let approvedIngredients: ApprovedIngredientItem[] = [...INITIAL_APPROVED_INGREDIENTS];
let factoryReports: FactoryAuditReportItem[] = [];

// Load persisted state if exists
function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed.isDemoCleared !== undefined) {
        isDemoCleared = Boolean(parsed.isDemoCleared);
      }

      if (Array.isArray(parsed.agencies) && parsed.agencies.length > 0) {
        agencies = parsed.agencies;
      } else {
        agencies = [...DEFAULT_AGENCIES];
      }

      // Ensure default agency is present
      for (const defAgency of DEFAULT_AGENCIES) {
        if (!agencies.some((a) => a.id === defAgency.id)) {
          agencies.push({ ...defAgency });
        }
      }

      if (isDemoCleared) {
        // Clean slate: venues, tasks, history, events are strictly what the user created
        venues = Array.isArray(parsed.venues) ? parsed.venues : [];
        tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        historyLogs = Array.isArray(parsed.historyLogs) ? parsed.historyLogs : [];
        events = Array.isArray(parsed.events) ? parsed.events : [];
        airtableConfigs = Array.isArray(parsed.airtableConfigs) ? parsed.airtableConfigs : [];
        approvedIngredients = Array.isArray(parsed.approvedIngredients) ? parsed.approvedIngredients : [];
        factoryReports = Array.isArray(parsed.factoryReports) ? parsed.factoryReports : [];

        if (Array.isArray(parsed.users) && parsed.users.length > 0) {
          users = parsed.users;
        } else {
          users = [DEFAULT_USERS[0]];
        }
      } else {
        if (Array.isArray(parsed.venues)) {
          venues = parsed.venues.map((v: any) => ({
            ...v,
            agencyId: v.agencyId || 'agency-hkc',
          }));
        } else {
          venues = [...DEFAULT_VENUES];
        }

        if (Array.isArray(parsed.tasks)) {
          // Sanitize: any task that is not completed should not retain completion attribution logs
          tasks = parsed.tasks.map((t: any) => {
            const matchingVenue = venues.find((v) => v.id === t.venueId);
            const assignedAgencyId = t.agencyId || matchingVenue?.agencyId || 'agency-hkc';
            return {
              ...t,
              agencyId: assignedAgencyId,
              venueId: t.venueId || 'venue-crown-market',
              ...(!t.isCompleted
                ? { updatedByEmail: null, updatedByName: null, updatedAt: null }
                : {}),
            };
          });
        }

        if (Array.isArray(parsed.historyLogs)) {
          historyLogs = parsed.historyLogs.map((h: any) => {
            const matchingVenue = venues.find((v) => v.id === h.venueId);
            return {
              ...h,
              agencyId: h.agencyId || matchingVenue?.agencyId || 'agency-hkc',
              venueId: h.venueId || 'venue-crown-market',
            };
          });
        }

        if (Array.isArray(parsed.users)) {
          users = parsed.users.map((u: any) => {
            let assignedVenue = u.venueId;
            if (!assignedVenue && u.role !== 'admin') {
              assignedVenue = 'venue-crown-market';
            }
            // Convert legacy role 'worker' to 'mashgiach'
            const role = u.role === 'worker' ? 'mashgiach' : (u.role || 'mashgiach');
            const permissions = u.permissions || {
              canFillTasks: role === 'admin' || role === 'coordinator' || role === 'mashgiach',
              canAssignTasks: role === 'admin' || role === 'coordinator',
            };
            return {
              ...u,
              role,
              permissions,
              agencyId: u.agencyId || 'agency-hkc',
              venueId: assignedVenue,
              password:
                u.password ||
                (role === 'admin' || u.email?.toLowerCase() === 'kenan@hartfordkashrut.org'
                  ? 'Kosher2026!'
                  : role === 'coordinator'
                  ? 'coord123'
                  : role === 'owner'
                  ? 'owner123'
                  : 'worker123'),
            };
          });

          // Ensure primary agency admin exists
          const adminUser = DEFAULT_USERS[0];
          if (!users.some((u) => u.email.toLowerCase() === adminUser.email.toLowerCase())) {
            users.unshift({ ...adminUser });
          }
        }

        if (Array.isArray(parsed.events)) {
          events = parsed.events;
        } else {
          events = [...INITIAL_EVENTS];
        }

        if (Array.isArray(parsed.airtableConfigs)) {
          airtableConfigs = parsed.airtableConfigs;
        } else {
          airtableConfigs = [...INITIAL_AIRTABLE_CONFIGS];
        }

        if (Array.isArray(parsed.approvedIngredients)) {
          approvedIngredients = parsed.approvedIngredients;
        } else {
          approvedIngredients = [...INITIAL_APPROVED_INGREDIENTS];
        }

        if (Array.isArray(parsed.factoryReports)) {
          factoryReports = parsed.factoryReports;
        } else {
          factoryReports = [];
        }
      }

      if (parsed.currentWorkDate) currentWorkDate = parsed.currentWorkDate;
    }
  } catch (err) {
    console.warn('Could not read store.json, using defaults:', err);
  }
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          agencies,
          venues,
          tasks,
          historyLogs,
          users,
          events,
          airtableConfigs,
          approvedIngredients,
          factoryReports,
          currentWorkDate,
          isDemoCleared,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (err) {
    console.warn('Could not save store.json:', err);
  }
}

loadState();

// WebSocket Setup
const wss = new WebSocketServer({ server, path: '/ws' });
const activeSockets = new Map<WebSocket, { email: string; name: string }>();

function broadcast(type: string, payload: any, senderEmail?: string) {
  const message = JSON.stringify({
    type,
    payload,
    timestamp: new Date().toISOString(),
    senderEmail,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  activeSockets.set(ws, { email: 'guest@company.com', name: 'Guest' });

  // Send initial state to newly connected client
  ws.send(
    JSON.stringify({
      type: 'INITIAL_STATE',
      payload: {
        venues,
        tasks,
        historyLogs,
        events,
        airtableConfigs,
        approvedIngredients,
        factoryReports,
        users: getSafeUsers(),
        currentWorkDate,
        activeWorkersCount: activeSockets.size,
      },
      timestamp: new Date().toISOString(),
    })
  );

  broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'USER_PRESENCE' && parsed.payload) {
        activeSockets.set(ws, {
          email: parsed.payload.email || 'guest@company.com',
          name: parsed.payload.name || 'Guest',
        });
        broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size });
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    activeSockets.delete(ws);
    broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size });
  });
});

// Daily Reset Logic (supports resetting a specific venue or all)
function executeDailyReset(targetVenueId?: string, resetBy: string = 'system') {
  const todayStr = new Date().toISOString().split('T')[0];
  const targetVenuesToReset = targetVenueId
    ? venues.filter((v) => v.id === targetVenueId)
    : venues;

  const snapshots: HistoryLog[] = [];

  for (const v of targetVenuesToReset) {
    const venueTasks = tasks.filter((t) => t.venueId === v.id);
    const completedCount = venueTasks.filter((t) => t.isCompleted).length;
    const totalCount = venueTasks.length;
    const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    const snapshot: HistoryLog = {
      id: `hist-${v.id}-${Date.now()}`,
      agencyId: v.agencyId || 'agency-hkc',
      venueId: v.id,
      date: currentWorkDate,
      totalTasks: totalCount,
      completedTasks: completedCount,
      completionRate: rate,
      resetAt: new Date().toISOString(),
      resetBy,
      entries: venueTasks.map((t) => ({
        id: `entry-${t.id}-${Date.now()}`,
        taskId: t.id,
        taskTitle: t.title,
        category: t.category,
        status: t.currentStatus,
        isCompleted: t.isCompleted,
        notes: t.notes,
        completedByEmail: t.updatedByEmail,
        completedByName: t.updatedByName,
        completedAt: t.updatedAt,
      })),
    };

    snapshots.push(snapshot);
    historyLogs = [snapshot, ...historyLogs];
  }

  // Reset tasks for the target venue(s)
  currentWorkDate = todayStr;
  tasks = tasks.map((t) => {
    if (targetVenueId && t.venueId !== targetVenueId) {
      return t;
    }

    let initialStatus = 'pending';
    if (t.inputType === 'yes_no') {
      initialStatus = 'no';
    } else if (
      t.inputType === 'status_select' &&
      Array.isArray(t.customStatusOptions) &&
      t.customStatusOptions.length > 0
    ) {
      initialStatus = t.customStatusOptions[0];
    }

    return {
      ...t,
      currentStatus: initialStatus,
      isCompleted: false,
      notes: '',
      updatedByEmail: null,
      updatedByName: null,
      updatedAt: null,
    };
  });

  saveState();

  // Broadcast to all clients
  broadcast('DAILY_RESET', {
    venueId: targetVenueId || 'all',
    tasks,
    historyLogs,
    currentWorkDate,
    snapshot: snapshots[0] || null,
  });

  return snapshots[0] || null;
}

// Scheduled interval: check every 60s for midnight rollover
setInterval(() => {
  const today = new Date().toISOString().split('T')[0];
  if (today !== currentWorkDate) {
    console.log(`[Scheduled Reset] Rollover detected from ${currentWorkDate} to ${today}`);
    executeDailyReset(undefined, 'scheduled_midnight_cron');
  }
}, 60000);

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    activeSockets: activeSockets.size,
    currentWorkDate,
    venuesCount: venues.length,
    tasksCount: tasks.length,
  });
});

// -------------------------------------------------------------
// KOSHER AGENCIES ENDPOINTS (Multi-Tenant Platform Support)
// -------------------------------------------------------------

// Register a brand new Kosher Agency & provision initial workspace
app.post('/api/agencies/register', (req, res) => {
  const {
    agencyName,
    shortCode,
    certificationSeal,
    region,
    contactPhone,
    adminName,
    adminEmail,
    adminPassword,
    initialVenueName,
    initialVenueCategory,
    includeStarterTemplates = true,
  } = req.body;

  if (!agencyName || !agencyName.trim()) {
    return res.status(400).json({ error: 'Kosher Agency Name is required (e.g. "Chicago Rabbinical Council (cRc)").' });
  }

  if (!adminEmail || !adminEmail.trim() || !adminEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid Administrator Work Email is required.' });
  }

  if (!adminPassword || adminPassword.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  if (users.some((u) => u.email.toLowerCase() === cleanAdminEmail)) {
    return res.status(409).json({ error: 'An administrator or staff account with this email already exists on the platform.' });
  }

  const cleanAgencyName = agencyName.trim();
  const agencyId = `agency-${Date.now()}`;
  const derivedShortCode =
    (shortCode && shortCode.trim()) ||
    cleanAgencyName
      .split(' ')
      .filter((w) => w.length > 0)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6) ||
    'KOSHER';

  const cleanSeal = (certificationSeal && certificationSeal.trim()) || `${cleanAgencyName} - Kosher Supervision`;
  const cleanRegion = (region && region.trim()) || 'Regional Kashrut Authority';

  const newAgency: Agency = {
    id: agencyId,
    name: cleanAgencyName,
    shortCode: derivedShortCode,
    adminEmail: cleanAdminEmail,
    certificationSeal: cleanSeal,
    region: cleanRegion,
    contactPhone: contactPhone ? contactPhone.trim() : undefined,
    createdAt: new Date().toISOString(),
  };

  agencies.push(newAgency);

  // Create primary Administrator profile for this agency
  const adminUser: UserProfile = {
    id: `usr_admin_${Date.now()}`,
    agencyId,
    email: cleanAdminEmail,
    name: (adminName && adminName.trim()) || `${cleanAgencyName} Administrator`,
    role: 'admin',
    avatarColor: '#3b82f6',
    password: adminPassword.trim(),
  };
  users.push(adminUser);

  // Create starter certified facility for this agency
  const venueId = `venue-${Date.now()}`;
  const venueName = (initialVenueName && initialVenueName.trim()) || `${cleanAgencyName} Certified Kitchen`;
  const venueCategory = (initialVenueCategory && initialVenueCategory.trim()) || 'Food Service';

  const starterVenue: Venue = {
    id: venueId,
    agencyId,
    name: venueName,
    category: venueCategory,
    address: cleanRegion,
    certification: cleanSeal,
    createdAt: new Date().toISOString(),
  };
  venues.push(starterVenue);

  // Create starter templates if requested
  let starterTasks: TaskItem[] = [];
  if (includeStarterTemplates) {
    const templateCat = venueCategory.toLowerCase().includes('bakery')
      ? 'bakery'
      : venueCategory.toLowerCase().includes('catering')
      ? 'catering'
      : 'restaurant';
    starterTasks = generateTemplateTasks(venueId, templateCat, agencyId);
    tasks.push(...starterTasks);
  }

  saveState();

  broadcast('AGENCY_REGISTERED', {
    agency: newAgency,
    adminEmail: cleanAdminEmail,
  });

  res.status(201).json({
    success: true,
    message: `Welcome to KeepingKosher! Agency ${cleanAgencyName} has been established.`,
    agency: newAgency,
    user: getSafeUser(adminUser),
    venue: starterVenue,
    tasks: starterTasks,
  });
});

// List all registered kosher agencies (with overview counts)
app.get('/api/agencies', (req, res) => {
  const safeAgencies = agencies.map((a) => {
    const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === a.id);
    const agencyUsers = users.filter((u) => (u.agencyId || 'agency-hkc') === a.id);
    return {
      ...a,
      venuesCount: agencyVenues.length,
      workersCount: agencyUsers.length,
    };
  });
  res.json({ agencies: safeAgencies });
});

// Get current agency details for logged in user
app.get('/api/agencies/current', (req, res) => {
  const { userEmail } = req.query;
  const user = userEmail
    ? users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase())
    : null;
  const agencyId = user?.agencyId || 'agency-hkc';
  const agency = agencies.find((a) => a.id === agencyId) || agencies[0];
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);
  const agencyUsers = users.filter((u) => (u.agencyId || 'agency-hkc') === agencyId);

  res.json({
    agency: {
      ...agency,
      venuesCount: agencyVenues.length,
      workersCount: agencyUsers.length,
    },
  });
});

// Agency administrator updates agency profile details
app.put('/api/agencies/current', (req, res) => {
  const { userEmail, name, shortCode, certificationSeal, region, contactPhone } = req.body;
  const user = userEmail
    ? users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase())
    : null;

  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Only kosher agency administrators can edit agency profile settings.' });
  }

  const agencyId = user.agencyId || 'agency-hkc';
  const index = agencies.findIndex((a) => a.id === agencyId);
  if (index === -1) {
    return res.status(404).json({ error: 'Agency record not found.' });
  }

  agencies[index] = {
    ...agencies[index],
    name: name !== undefined ? name.trim() : agencies[index].name,
    shortCode: shortCode !== undefined ? shortCode.trim() : agencies[index].shortCode,
    certificationSeal: certificationSeal !== undefined ? certificationSeal.trim() : agencies[index].certificationSeal,
    region: region !== undefined ? region.trim() : agencies[index].region,
    contactPhone: contactPhone !== undefined ? contactPhone.trim() : agencies[index].contactPhone,
  };

  saveState();
  broadcast('AGENCY_UPDATED', { agency: agencies[index] }, userEmail);
  res.json({ success: true, agency: agencies[index] });
});

// -------------------------------------------------------------
// VENUES ENDPOINTS (Multi-Tenant Management Scoped to Kosher Agency)
// -------------------------------------------------------------

// Get venues list. Strictly scoped to the caller's kosher agency!
app.get('/api/venues', (req, res) => {
  const { userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let isCallerAdmin = true;
  let callerVenueId: string | undefined = undefined;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      isCallerAdmin = user.role === 'admin';
      callerVenueId = user.venueId;
    }
  }

  // Filter venues STRICTLY by caller's agency
  let accessibleVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);

  // If worker or owner, additionally filter to their assigned venue within the agency
  if (!isCallerAdmin) {
    if (callerVenueId) {
      accessibleVenues = accessibleVenues.filter((v) => v.id === callerVenueId);
    } else if (accessibleVenues.length > 0) {
      accessibleVenues = [accessibleVenues[0]];
    }
  }

  // Calculate live statistics for each venue
  const venuesWithStats = accessibleVenues.map((v) => {
    const venueTasks = tasks.filter((t) => t.venueId === v.id);
    const completedTasks = venueTasks.filter((t) => t.isCompleted).length;
    const totalTasks = venueTasks.length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const venueWorkers = users.filter((u) => u.venueId === v.id && (u.role === 'mashgiach' || u.role === 'worker' || u.role === 'coordinator'));

    return {
      ...v,
      totalTasksToday: totalTasks,
      completedTasksToday: completedTasks,
      completionRate,
      workerCount: venueWorkers.length,
    };
  });

  res.json({ venues: venuesWithStats, isDemoCleared });
});

// Admin creates a brand new venue within their agency
app.post('/api/venues', (req, res) => {
  const {
    name,
    category,
    address,
    certification,
    ownerName,
    ownerEmail,
    ownerPassword,
    templateType,
    userEmail,
  } = req.body;

  let callerAgencyId = 'agency-hkc';
  let callerAgency: Agency | undefined = undefined;

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only agency administrators can create new venue platforms.' });
    }
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
    }
  }

  callerAgency = agencies.find((a) => a.id === callerAgencyId) || agencies[0];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Venue Name is required.' });
  }

  const newVenueId = `venue-${Date.now()}`;
  const cleanOwnerEmail = ownerEmail?.trim().toLowerCase() || undefined;

  const newVenue: Venue = {
    id: newVenueId,
    agencyId: callerAgencyId,
    name: name.trim(),
    category: category?.trim() || 'Food Service',
    address: address?.trim() || callerAgency?.region || 'West Hartford, CT',
    certification: certification?.trim() || callerAgency?.certificationSeal || 'Certified Kosher',
    ownerEmail: cleanOwnerEmail,
    createdAt: new Date().toISOString(),
  };

  venues.push(newVenue);

  // If an owner was provided, register them as the venue owner under this agency
  let createdOwner: UserProfile | null = null;
  if (cleanOwnerEmail) {
    const existingOwnerIndex = users.findIndex((u) => u.email.toLowerCase() === cleanOwnerEmail);
    if (existingOwnerIndex !== -1) {
      users[existingOwnerIndex].venueId = newVenueId;
      users[existingOwnerIndex].role = 'owner';
      users[existingOwnerIndex].agencyId = callerAgencyId;
      createdOwner = users[existingOwnerIndex];
    } else {
      const ownerUser: UserProfile = {
        id: `usr_owner_${Date.now()}`,
        agencyId: callerAgencyId,
        email: cleanOwnerEmail,
        name: ownerName?.trim() || `${name.trim()} Owner`,
        role: 'owner',
        venueId: newVenueId,
        avatarColor: '#d97706',
        password: ownerPassword?.trim() || 'owner123',
      };
      users.push(ownerUser);
      createdOwner = ownerUser;
    }
  }

  // Generate starter tasks based on template choice and tag with agencyId
  const starterTasks = generateTemplateTasks(newVenueId, templateType || 'restaurant', callerAgencyId);
  tasks.push(...starterTasks);

  saveState();

  broadcast('VENUE_CREATED', {
    venue: newVenue,
    agencyId: callerAgencyId,
    tasksCount: starterTasks.length,
    owner: createdOwner ? getSafeUser(createdOwner) : null,
  });

  res.status(201).json({
    success: true,
    venue: newVenue,
    tasks: starterTasks,
    owner: createdOwner ? getSafeUser(createdOwner) : null,
  });
});

// Admin edits venue details
app.put('/api/venues/:id', (req, res) => {
  const { id } = req.params;
  const { name, category, address, certification, ownerEmail, userEmail } = req.body;

  let callerAgencyId = 'agency-hkc';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can modify venue settings.' });
    }
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
    }
  }

  const index = venues.findIndex((v) => v.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Venue not found.' });
  }

  const existing = venues[index];
  if (existing.agencyId && existing.agencyId !== callerAgencyId) {
    return res.status(403).json({ error: 'You do not have permission to modify venues outside your agency.' });
  }

  const updated: Venue = {
    ...existing,
    name: name !== undefined ? name.trim() : existing.name,
    category: category !== undefined ? category.trim() : existing.category,
    address: address !== undefined ? address.trim() : existing.address,
    certification: certification !== undefined ? certification.trim() : existing.certification,
    ownerEmail: ownerEmail !== undefined ? ownerEmail?.trim().toLowerCase() : existing.ownerEmail,
  };

  venues[index] = updated;
  saveState();

  broadcast('VENUE_UPDATED', { venue: updated, agencyId: callerAgencyId });
  res.json({ success: true, venue: updated });
});

// Admin deletes a venue
app.delete('/api/venues/:id', (req, res) => {
  const { id } = req.params;
  const { userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can remove venue platforms.' });
    }
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
    }
  }

  const index = venues.findIndex((v) => v.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Venue not found.' });
  }

  if (venues[index].agencyId && venues[index].agencyId !== callerAgencyId) {
    return res.status(403).json({ error: 'You do not have permission to delete venues outside your agency.' });
  }

  venues.splice(index, 1);
  // Cascade delete associated tasks and history
  tasks = tasks.filter((t) => t.venueId !== id);
  historyLogs = historyLogs.filter((h) => h.venueId !== id);

  saveState();

  broadcast('VENUE_DELETED', { deletedVenueId: id, agencyId: callerAgencyId });
  res.json({ success: true, deletedVenueId: id });
});

// -------------------------------------------------------------
// TASKS ENDPOINTS (Filtered by Venue)
// -------------------------------------------------------------

app.get('/api/tasks', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let isCallerAdmin = true;
  let callerVenueId: string | undefined = undefined;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      isCallerAdmin = user.role === 'admin';
      callerVenueId = user.venueId;
    }
  }

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  let targetVenueId = venueId ? String(venueId) : agencyVenues[0]?.id || 'venue-crown-market';

  // Strict tenant boundary: workers and owners only access their assigned venue
  if (!isCallerAdmin) {
    targetVenueId = callerVenueId || agencyVenues[0]?.id || 'venue-crown-market';
  } else {
    // If admin requested a venueId, ensure it belongs to their agency
    if (!agencyVenues.some((v) => v.id === targetVenueId) && agencyVenues.length > 0) {
      targetVenueId = agencyVenues[0].id;
    }
  }

  const filteredTasks = tasks.filter(
    (t) => t.venueId === targetVenueId && (t.agencyId || 'agency-hkc') === callerAgencyId
  );
  const activeVenue = agencyVenues.find((v) => v.id === targetVenueId) || agencyVenues[0] || venues[0];

  res.json({
    tasks: filteredTasks,
    venue: activeVenue,
    venueId: targetVenueId,
    currentWorkDate,
    totalTasks: filteredTasks.length,
    completedCount: filteredTasks.filter((t) => t.isCompleted).length,
  });
});

app.post('/api/tasks', (req, res) => {
  const {
    venueId,
    title,
    description,
    category,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    priority,
    createdByEmail,
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const caller = createdByEmail
    ? users.find((u) => u.email.toLowerCase() === String(createdByEmail).trim().toLowerCase())
    : null;
  const callerAgencyId = caller?.agencyId || 'agency-hkc';

  // Permission check: Admin, Coordinator, or user with canAssignTasks permission
  if (caller) {
    const isAllowedToAssign =
      caller.role === 'admin' ||
      caller.role === 'coordinator' ||
      caller.permissions?.canAssignTasks === true;
    if (!isAllowedToAssign) {
      return res.status(403).json({ error: 'You do not have permission to assign or create new tasks.' });
    }
  }

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  const targetVenueId = venueId || agencyVenues[0]?.id || 'venue-crown-market';

  let defaultStatus = 'pending';
  if (inputType === 'yes_no') {
    defaultStatus = 'no';
  } else if (inputType === 'status_select' && Array.isArray(customStatusOptions) && customStatusOptions.length > 0) {
    defaultStatus = customStatusOptions[0];
  }

  const newTask: TaskItem = {
    id: `task-${crypto.randomUUID()}`,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    title,
    description: description || '',
    category: category || 'General',
    inputType: inputType || 'yes_no',
    customStatusOptions: Array.isArray(customStatusOptions) && customStatusOptions.length > 0 ? customStatusOptions : undefined,
    completedStatusValues: Array.isArray(completedStatusValues) && completedStatusValues.length > 0 ? completedStatusValues : undefined,
    assignedTo: Array.isArray(assignedTo) && assignedTo.length > 0 ? assignedTo : ['all'],
    scheduleType: scheduleType === 'specific_dates' ? 'specific_dates' : 'recurring',
    daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6],
    specificDates: Array.isArray(specificDates) ? specificDates : undefined,
    targetTime: targetTime || 'End of Day',
    priority: priority || 'medium',
    currentStatus: defaultStatus,
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    createdAt: new Date().toISOString(),
  };

  tasks.push(newTask);
  saveState();

  broadcast('TASK_CREATED', newTask, createdByEmail);
  res.status(201).json(newTask);
});

// Update task status, notes, or configuration
app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const index = tasks.findIndex((t) => t.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const existing = tasks[index];
  const {
    currentStatus,
    isCompleted,
    notes,
    userEmail,
    userName,
    title,
    description,
    category,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    priority,
  } = req.body;

  const hasStatusChange = currentStatus !== undefined || isCompleted !== undefined || notes !== undefined;
  const isDefinitionEdit =
    title !== undefined ||
    description !== undefined ||
    category !== undefined ||
    inputType !== undefined ||
    customStatusOptions !== undefined ||
    completedStatusValues !== undefined ||
    assignedTo !== undefined ||
    scheduleType !== undefined ||
    daysOfWeek !== undefined ||
    specificDates !== undefined ||
    targetTime !== undefined ||
    priority !== undefined;

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === userEmail.trim().toLowerCase());
    if (caller) {
      // Check definition edit permissions
      if (isDefinitionEdit) {
        const canAssign =
          caller.role === 'admin' ||
          caller.role === 'coordinator' ||
          caller.permissions?.canAssignTasks === true;
        if (!canAssign) {
          return res.status(403).json({ error: 'You do not have permission to edit task definitions.' });
        }
      }

      // Check fill / complete / notes permission
      if (hasStatusChange) {
        const canFill =
          caller.role === 'admin' ||
          (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
          ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
          (caller.role === 'owner' && caller.permissions?.canFillTasks === true);

        if (!canFill) {
          return res.status(403).json({ error: 'You do not have permission to fill or update task statuses.' });
        }
      }
    }
  }

  const finalIsCompleted = isCompleted !== undefined ? Boolean(isCompleted) : existing.isCompleted;

  // When someone cancels their choice or marks as incomplete, delete the completion log
  const updatedByEmail = finalIsCompleted ? (userEmail || existing.updatedByEmail || null) : null;
  const updatedByName = finalIsCompleted ? (userName || existing.updatedByName || null) : null;
  const updatedAt = finalIsCompleted ? (hasStatusChange ? new Date().toISOString() : existing.updatedAt) : null;

  const updated: TaskItem = {
    ...existing,
    title: title !== undefined ? title : existing.title,
    description: description !== undefined ? description : existing.description,
    category: category !== undefined ? category : existing.category,
    inputType: inputType !== undefined ? inputType : existing.inputType,
    customStatusOptions: customStatusOptions !== undefined ? customStatusOptions : existing.customStatusOptions,
    completedStatusValues: completedStatusValues !== undefined ? completedStatusValues : existing.completedStatusValues,
    assignedTo: assignedTo !== undefined ? assignedTo : existing.assignedTo,
    scheduleType: scheduleType !== undefined ? scheduleType : existing.scheduleType,
    daysOfWeek: daysOfWeek !== undefined ? daysOfWeek : existing.daysOfWeek,
    specificDates: specificDates !== undefined ? specificDates : existing.specificDates,
    targetTime: targetTime !== undefined ? targetTime : existing.targetTime,
    priority: priority !== undefined ? priority : existing.priority,
    currentStatus: currentStatus !== undefined ? currentStatus : (finalIsCompleted ? existing.currentStatus : 'pending'),
    isCompleted: finalIsCompleted,
    notes: notes !== undefined ? notes : existing.notes,
    updatedByEmail,
    updatedByName,
    updatedAt,
  };

  tasks[index] = updated;
  saveState();

  broadcast('TASK_UPDATED', updated, userEmail);
  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const deletedTask = tasks.find((t) => t.id === id);

  if (!deletedTask) {
    return res.status(404).json({ error: 'Task not found' });
  }

  tasks = tasks.filter((t) => t.id !== id);
  saveState();

  broadcast('TASK_DELETED', { id, venueId: deletedTask.venueId, agencyId: deletedTask.agencyId });
  res.json({ success: true, deletedId: id });
});

// Admin manual reset daily board for a venue
app.post('/api/reset-daily', (req, res) => {
  const { venueId, resetBy, userEmail } = req.body;
  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
    }
  }
  const snapshot = executeDailyReset(venueId, resetBy || 'Admin Manual');
  const venueTasks = tasks.filter(
    (t) => (!venueId || t.venueId === venueId) && (t.agencyId || 'agency-hkc') === callerAgencyId
  );
  res.json({ success: true, snapshot, tasks: venueTasks });
});

// Admin Wipes All Demo Data to Start Completely From Scratch
app.post('/api/admin/clean-slate', (req, res) => {
  const { userEmail } = req.body;
  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
  if (!caller || caller.role !== 'admin') {
    return res.status(403).json({ error: 'Only administrators can reset the platform to a clean slate.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';

  // Wipe tasks, history, events, and venues for this agency
  tasks = tasks.filter((t) => (t.agencyId || 'agency-hkc') !== callerAgencyId);
  historyLogs = historyLogs.filter((h) => (h.agencyId || 'agency-hkc') !== callerAgencyId);
  events = events.filter((e) => (e.agencyId || 'agency-hkc') !== callerAgencyId);
  venues = venues.filter((v) => (v.agencyId || 'agency-hkc') !== callerAgencyId);
  airtableConfigs = airtableConfigs.filter((c) => (c.agencyId || 'agency-hkc') !== callerAgencyId);
  approvedIngredients = approvedIngredients.filter((i) => (i.agencyId || 'agency-hkc') !== callerAgencyId);
  factoryReports = factoryReports.filter((r) => (r.agencyId || 'agency-hkc') !== callerAgencyId);

  // Keep admin user(s)
  users = users.filter(
    (u) => (u.agencyId || 'agency-hkc') !== callerAgencyId || u.role === 'admin' || u.email.toLowerCase() === caller.email.toLowerCase()
  );

  isDemoCleared = true;
  saveState();

  broadcast('CLEAN_SLATE_RESET', {
    agencyId: callerAgencyId,
    venues: [],
    tasks: [],
    events: [],
    users: getSafeUsers(),
    isDemoCleared: true,
  });

  res.json({
    success: true,
    isDemoCleared: true,
    venues: [],
    tasks: [],
    events: [],
    users: getSafeUsers(),
    message: 'All demo facilities and example data have been cleared. Ready to start from scratch!',
  });
});

// Admin Restores Demonstration Facilities and Data
app.post('/api/admin/restore-demo', (req, res) => {
  const { userEmail } = req.body;
  const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
  if (!caller || caller.role !== 'admin') {
    return res.status(403).json({ error: 'Only administrators can restore demonstration data.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';

  // Re-seed default venues, tasks, events, and users
  venues = [...venues.filter((v) => (v.agencyId || 'agency-hkc') !== callerAgencyId), ...DEFAULT_VENUES];
  tasks = [...tasks.filter((t) => (t.agencyId || 'agency-hkc') !== callerAgencyId), ...INITIAL_TASKS];
  historyLogs = [...historyLogs.filter((h) => (h.agencyId || 'agency-hkc') !== callerAgencyId), ...INITIAL_HISTORY];
  events = [...events.filter((e) => (e.agencyId || 'agency-hkc') !== callerAgencyId), ...INITIAL_EVENTS];
  airtableConfigs = [...airtableConfigs.filter((c) => (c.agencyId || 'agency-hkc') !== callerAgencyId), ...INITIAL_AIRTABLE_CONFIGS];
  approvedIngredients = [...approvedIngredients.filter((i) => (i.agencyId || 'agency-hkc') !== callerAgencyId), ...INITIAL_APPROVED_INGREDIENTS];

  for (const defUser of DEFAULT_USERS) {
    if (!users.some((u) => u.email.toLowerCase() === defUser.email.toLowerCase())) {
      users.push({ ...defUser });
    }
  }

  isDemoCleared = false;
  saveState();

  broadcast('DEMO_RESTORED', {
    agencyId: callerAgencyId,
    venues,
    tasks,
    events,
    users: getSafeUsers(),
    isDemoCleared: false,
  });

  res.json({
    success: true,
    isDemoCleared: false,
    venues,
    tasks,
    events,
    users: getSafeUsers(),
    message: 'Demo facilities, mashgichim, and inspection tasks have been restored.',
  });
});

app.get('/api/history', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let targetVenueId = venueId ? String(venueId) : null;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      if (user.role !== 'admin') {
        targetVenueId = user.venueId || null;
      }
    }
  }

  // Filter logs strictly by caller agency
  const agencyHistory = historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === callerAgencyId);

  if (targetVenueId) {
    res.json({ historyLogs: agencyHistory.filter((h) => h.venueId === targetVenueId) });
  } else {
    res.json({ historyLogs: agencyHistory });
  }
});

// -------------------------------------------------------------
// KOSHER EVENTS ENDPOINTS
// -------------------------------------------------------------

app.get('/api/events', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let callerRole = 'admin';
  let callerVenueId: string | undefined = undefined;
  let normalizedUserEmail = '';

  if (userEmail) {
    normalizedUserEmail = String(userEmail).trim().toLowerCase();
    const user = users.find((u) => u.email.toLowerCase() === normalizedUserEmail);
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      callerRole = user.role;
      callerVenueId = user.venueId;
    }
  }

  // Filter events strictly by agency
  let agencyEvents = events.filter((e) => (e.agencyId || 'agency-hkc') === callerAgencyId);

  // If user is owner or coordinator, restrict to their venue unless admin
  if (callerRole === 'owner') {
    agencyEvents = agencyEvents.filter((e) => e.venueId === callerVenueId);
  } else if (callerRole === 'mashgiach') {
    // Mashgiach sees events assigned to them OR events in their venue
    agencyEvents = agencyEvents.filter(
      (e) =>
        (e.assignedMashgiachEmail && e.assignedMashgiachEmail.toLowerCase() === normalizedUserEmail) ||
        (callerVenueId && e.venueId === callerVenueId)
    );
  } else if (venueId && venueId !== 'all') {
    agencyEvents = agencyEvents.filter((e) => e.venueId === String(venueId));
  }

  // Sort by date ascending
  agencyEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  res.json({ events: agencyEvents });
});

app.post('/api/events', (req, res) => {
  const {
    venueId,
    title,
    location,
    date,
    endDate,
    startTime,
    endTime,
    mashgiachType,
    assignedMashgiachEmail,
    assignedMashgiachName,
    externalMashgiach,
    menuAttachmentName,
    menuAttachmentData,
    notes,
    tasks: initialTasks,
    userEmail,
    userName,
  } = req.body;

  if (!title || !location || !date) {
    return res.status(400).json({ error: 'Title, location, and date are required.' });
  }

  let callerAgencyId = 'agency-hkc';
  let creatorEmail = userEmail || 'admin@kosherkitchen.com';
  let creatorName = userName || 'Staff Member';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      creatorName = caller.name;
    }
  }

  const targetVenueId = venueId || 'venue-crown-market';
  const targetVenue = venues.find((v) => v.id === targetVenueId);

  // Resolve assigned mashgiach details
  let resolvedMashgiachEmail = assignedMashgiachEmail;
  let resolvedMashgiachName = assignedMashgiachName;

  if (mashgiachType === 'assigned_user' && assignedMashgiachEmail) {
    const matchedUser = users.find((u) => u.email.toLowerCase() === assignedMashgiachEmail.toLowerCase());
    if (matchedUser) {
      resolvedMashgiachName = matchedUser.name;
    }
  }

  // Default tasks for a new event if none provided
  const starterTasks: EventTaskItem[] = Array.isArray(initialTasks) && initialTasks.length > 0
    ? initialTasks.map((t: any, idx: number) => ({
        id: `etask-${Date.now()}-${idx}`,
        title: t.title || 'Event Kosher Inspection Task',
        description: t.description || '',
        category: t.category || 'Inspection',
        isCompleted: Boolean(t.isCompleted),
        notes: t.notes || '',
      }))
    : [
        {
          id: `etask-${Date.now()}-1`,
          title: 'Tamper-Evident Delivery Seals & Manifest Verification',
          description: 'Inspect seals on all delivery Cambros and containers before venue entry.',
          category: 'Delivery',
          isCompleted: false,
          notes: '',
        },
        {
          id: `etask-${Date.now()}-2`,
          title: 'Ballroom / Banquet Kitchen Warmers & Bishul Yisroel Check',
          description: 'Verify heating element switches and pilot lights ignited according to standard.',
          category: 'Bishul Yisroel',
          isCompleted: false,
          notes: '',
        },
        {
          id: `etask-${Date.now()}-3`,
          title: 'Post-Event Kashrut Wrap-up & Meat/Dairy Separation',
          description: 'Ensure all serving gear is crate-sealed and segregated before transport.',
          category: 'Post-Event Wrapup',
          isCompleted: false,
          notes: '',
        },
      ];

  const newEvent: KosherEventItem = {
    id: `evt-${Date.now()}`,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    venueName: targetVenue?.name || 'Supervised Establishment',
    title: title.trim(),
    location: location.trim(),
    date,
    endDate,
    startTime: startTime || '12:00 PM',
    endTime: endTime || '16:00 PM',
    mashgiachType: mashgiachType || (assignedMashgiachEmail ? 'assigned_user' : externalMashgiach ? 'external' : 'unassigned'),
    assignedMashgiachEmail: resolvedMashgiachEmail,
    assignedMashgiachName: resolvedMashgiachName,
    externalMashgiach: externalMashgiach && externalMashgiach.name ? {
      name: externalMashgiach.name.trim(),
      phone: externalMashgiach.phone ? externalMashgiach.phone.trim() : '',
      email: externalMashgiach.email ? externalMashgiach.email.trim() : '',
    } : undefined,
    menuAttachmentName: menuAttachmentName || undefined,
    menuAttachmentData: menuAttachmentData || undefined,
    notes: notes || '',
    status: 'confirmed',
    tasks: starterTasks,
    createdByEmail: creatorEmail,
    createdByName: creatorName,
    createdAt: new Date().toISOString(),
  };

  events.push(newEvent);
  saveState();

  broadcast('EVENT_CREATED', {
    event: newEvent,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    assignedMashgiachEmail: resolvedMashgiachEmail,
  });

  res.status(201).json({ event: newEvent });
});

app.put('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const eventIndex = events.findIndex((e) => e.id === id);

  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  const existing = events[eventIndex];
  const {
    title,
    location,
    date,
    endDate,
    startTime,
    endTime,
    mashgiachType,
    assignedMashgiachEmail,
    assignedMashgiachName,
    externalMashgiach,
    menuAttachmentName,
    menuAttachmentData,
    notes,
    status,
    tasks: updatedTasks,
    userEmail,
    userName,
  } = req.body;

  let resolvedMashgiachEmail = assignedMashgiachEmail !== undefined ? assignedMashgiachEmail : existing.assignedMashgiachEmail;
  let resolvedMashgiachName = assignedMashgiachName !== undefined ? assignedMashgiachName : existing.assignedMashgiachName;

  if (assignedMashgiachEmail) {
    const matchedUser = users.find((u) => u.email.toLowerCase() === assignedMashgiachEmail.toLowerCase());
    if (matchedUser) {
      resolvedMashgiachName = matchedUser.name;
    }
  }

  const updated: KosherEventItem = {
    ...existing,
    title: title !== undefined ? title : existing.title,
    location: location !== undefined ? location : existing.location,
    date: date !== undefined ? date : existing.date,
    endDate: endDate !== undefined ? endDate : existing.endDate,
    startTime: startTime !== undefined ? startTime : existing.startTime,
    endTime: endTime !== undefined ? endTime : existing.endTime,
    mashgiachType: mashgiachType !== undefined ? mashgiachType : existing.mashgiachType,
    assignedMashgiachEmail: resolvedMashgiachEmail,
    assignedMashgiachName: resolvedMashgiachName,
    externalMashgiach: externalMashgiach !== undefined ? externalMashgiach : existing.externalMashgiach,
    menuAttachmentName: menuAttachmentName !== undefined ? menuAttachmentName : existing.menuAttachmentName,
    menuAttachmentData: menuAttachmentData !== undefined ? menuAttachmentData : existing.menuAttachmentData,
    notes: notes !== undefined ? notes : existing.notes,
    status: status !== undefined ? status : existing.status,
    tasks: updatedTasks !== undefined ? updatedTasks : existing.tasks,
    updatedAt: new Date().toISOString(),
  };

  events[eventIndex] = updated;
  saveState();

  broadcast('EVENT_UPDATED', {
    event: updated,
    agencyId: updated.agencyId,
    venueId: updated.venueId,
    assignedMashgiachEmail: updated.assignedMashgiachEmail,
  });

  res.json({ event: updated });
});

app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const eventIndex = events.findIndex((e) => e.id === id);

  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  const deletedEvent = events[eventIndex];
  events.splice(eventIndex, 1);
  saveState();

  broadcast('EVENT_DELETED', {
    id,
    agencyId: deletedEvent.agencyId,
    venueId: deletedEvent.venueId,
  });

  res.json({ success: true, deletedId: id });
});

// Event Task Toggle / Status Endpoint
app.post('/api/events/:id/tasks/:taskId/toggle', (req, res) => {
  const { id, taskId } = req.params;
  const { isCompleted, notes, userEmail, userName } = req.body;

  const event = events.find((e) => e.id === id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  const task = event.tasks.find((t) => t.id === taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found in this event.' });
  }

  const targetCompleted = isCompleted !== undefined ? Boolean(isCompleted) : !task.isCompleted;

  task.isCompleted = targetCompleted;
  if (notes !== undefined) task.notes = notes;

  if (targetCompleted) {
    task.completedAt = new Date().toISOString();
    task.completedByName = userName || 'Mashgiach';
    task.completedByEmail = userEmail || null;
  } else {
    task.completedAt = null;
    task.completedByName = null;
    task.completedByEmail = null;
  }

  event.updatedAt = new Date().toISOString();
  saveState();

  broadcast('EVENT_UPDATED', {
    event,
    agencyId: event.agencyId,
    venueId: event.venueId,
    assignedMashgiachEmail: event.assignedMashgiachEmail,
  });

  res.json({ success: true, event, task });
});

app.get('/api/users', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let targetVenueId = venueId ? String(venueId) : null;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      if (user.role !== 'admin') {
        targetVenueId = user.venueId || null;
      }
    }
  }

  // Scope to caller's agency
  let agencyUsers = getSafeUsers().filter((u) => (u.agencyId || 'agency-hkc') === callerAgencyId);

  if (targetVenueId) {
    // Return users assigned to this venue OR agency admins
    agencyUsers = agencyUsers.filter((u) => u.role === 'admin' || u.venueId === targetVenueId);
  }

  res.json({ users: agencyUsers });
});

app.post('/api/users', (req, res) => {
  const { email, name, role, password, venueId, userEmail, permissions } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Email and name are required' });
  }

  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
    }
  }

  const initialPassword =
    (password && String(password).trim()) ||
    (role === 'coordinator' ? 'coord123' : role === 'owner' ? 'owner123' : 'worker123');

  const existing = users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'A team member with this email already exists' });
  }

  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f97316'];
  const validRole =
    role === 'admin'
      ? 'admin'
      : role === 'coordinator'
      ? 'coordinator'
      : role === 'owner'
      ? 'owner'
      : 'mashgiach';

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  const targetVenueId = validRole === 'admin' ? undefined : (venueId || agencyVenues[0]?.id || 'venue-crown-market');

  const defaultPermissions: UserPermissions = {
    canFillTasks:
      permissions?.canFillTasks !== undefined
        ? Boolean(permissions.canFillTasks)
        : validRole === 'admin' || validRole === 'coordinator' || validRole === 'mashgiach',
    canAssignTasks:
      permissions?.canAssignTasks !== undefined
        ? Boolean(permissions.canAssignTasks)
        : validRole === 'admin' || validRole === 'coordinator',
  };

  const newUser: UserProfile = {
    id: `usr_${Date.now()}`,
    agencyId: callerAgencyId,
    email: email.trim().toLowerCase(),
    name: name.trim(),
    role: validRole,
    venueId: targetVenueId,
    permissions: defaultPermissions,
    avatarColor: colors[Math.floor(Math.random() * colors.length)],
    password: initialPassword,
  };

  users.push(newUser);
  saveState();
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: callerAgencyId });
  res.status(201).json({ user: getSafeUser(newUser) });
});

// Update user permissions or role
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const userIndex = users.findIndex((u) => u.id === id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'Team member not found' });
  }

  const { role, permissions, venueId, name } = req.body;
  const existingUser = users[userIndex];

  if (name !== undefined) {
    existingUser.name = name.trim();
  }
  if (venueId !== undefined) {
    existingUser.venueId = venueId;
  }
  if (role !== undefined) {
    existingUser.role =
      role === 'admin'
        ? 'admin'
        : role === 'coordinator'
        ? 'coordinator'
        : role === 'owner'
        ? 'owner'
        : 'mashgiach';
  }
  if (permissions !== undefined) {
    existingUser.permissions = {
      ...(existingUser.permissions || {}),
      ...(permissions.canFillTasks !== undefined ? { canFillTasks: Boolean(permissions.canFillTasks) } : {}),
      ...(permissions.canAssignTasks !== undefined ? { canAssignTasks: Boolean(permissions.canAssignTasks) } : {}),
    };
  }

  saveState();
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: existingUser.agencyId });
  res.json({ user: getSafeUser(existingUser) });
});

app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const userIndex = users.findIndex((u) => u.id === id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'Worker not found' });
  }

  const userToDelete = users[userIndex];
  // Check if primary admin for this agency
  const userAgency = agencies.find((a) => a.id === userToDelete.agencyId);
  if (
    userToDelete.email.toLowerCase() === 'kenan@hartfordkashrut.org' ||
    (userAgency && userToDelete.email.toLowerCase() === userAgency.adminEmail.toLowerCase())
  ) {
    return res.status(400).json({ error: 'Cannot delete the primary administrator account for this agency.' });
  }

  users.splice(userIndex, 1);
  saveState();
  broadcast('USERS_UPDATED', { users: getSafeUsers(), deletedId: id, agencyId: userToDelete.agencyId });
  res.json({ success: true, deletedId: id });
});

// Formal Login Endpoint
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter both your email and password.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);

  if (!user) {
    return res.status(401).json({ error: 'Account not found. Please verify your email or ask your admin to register you.' });
  }

  const isKenanAdmin = user.role === 'admin' || user.email.toLowerCase() === 'kenan@hartfordkashrut.org';
  const isValidAdminPass = isKenanAdmin && (password.trim() === 'Kosher2026!' || password.trim() === 'admin123');

  const storedPassword =
    user.password ||
    (isKenanAdmin
      ? 'Kosher2026!'
      : user.role === 'owner'
      ? 'owner123'
      : 'worker123');

  if (storedPassword !== password.trim() && !isValidAdminPass) {
    return res.status(401).json({ error: 'Incorrect password. Please try again or request a reset.' });
  }

  res.json({
    success: true,
    user: getSafeUser(user),
  });
});

// Change Password Endpoint
app.post('/api/auth/change-password', (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are both required.' });
  }

  if (newPassword.trim().length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const userIndex = users.findIndex((u) => u.email.toLowerCase() === normalizedEmail);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  const user = users[userIndex];
  const storedPassword =
    user.password ||
    (user.role === 'admin' || user.email.toLowerCase() === 'kenan@hartfordkashrut.org'
      ? 'Kosher2026!'
      : user.role === 'owner'
      ? 'owner123'
      : 'worker123');

  if (storedPassword !== currentPassword.trim()) {
    return res.status(401).json({ error: 'Current password does not match.' });
  }

  users[userIndex].password = newPassword.trim();
  saveState();

  res.json({ success: true, message: 'Password updated successfully.' });
});

// ==========================================
// AIRTABLE & FACTORY INGREDIENTS AUDIT APIS
// ==========================================

// Get Airtable Config for agency or venue
app.get('/api/airtable/config', (req, res) => {
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

  const config =
    (venueId ? airtableConfigs.find((c) => c.venueId === venueId && c.agencyId === callerAgencyId) : null) ||
    airtableConfigs.find((c) => c.agencyId === callerAgencyId) || {
      agencyId: callerAgencyId,
      venueId: venueId ? String(venueId) : undefined,
      baseId: '',
      tableName: 'Approved Ingredients',
      viewName: 'Grid view',
    };

  // Mask apiKey for safety if present
  const safeConfig = {
    ...config,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)}` : '',
    hasApiKey: Boolean(config.apiKey),
  };

  res.json({ config: safeConfig });
});

// Save or Update Airtable Config
app.post('/api/airtable/config', (req, res) => {
  const { venueId, agencyId, apiKey, baseId, tableName, viewName, fieldNameMapping, userEmail } = req.body;
  
  let callerAgencyId = agencyId || 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || callerAgencyId;
  }

  let existingIndex = airtableConfigs.findIndex(
    (c) => c.agencyId === callerAgencyId && (venueId ? c.venueId === venueId : true)
  );

  const updatedConfig: AirtableConfigItem = {
    id: existingIndex >= 0 ? airtableConfigs[existingIndex].id : `atcfg_${Date.now()}`,
    agencyId: callerAgencyId,
    venueId: venueId || undefined,
    apiKey: apiKey !== undefined ? (apiKey ? apiKey.trim() : (existingIndex >= 0 ? airtableConfigs[existingIndex].apiKey : '')) : (existingIndex >= 0 ? airtableConfigs[existingIndex].apiKey : ''),
    baseId: (baseId || '').trim(),
    tableName: (tableName || 'Approved Ingredients').trim(),
    viewName: (viewName || 'Grid view').trim(),
    fieldNameMapping: fieldNameMapping || (existingIndex >= 0 ? airtableConfigs[existingIndex].fieldNameMapping : undefined),
    lastSyncedAt: existingIndex >= 0 ? airtableConfigs[existingIndex].lastSyncedAt : new Date().toISOString(),
    autoSyncEnabled: true,
  };

  if (existingIndex >= 0) {
    airtableConfigs[existingIndex] = updatedConfig;
  } else {
    airtableConfigs.push(updatedConfig);
  }

  saveState();
  res.json({
    success: true,
    config: {
      ...updatedConfig,
      apiKey: updatedConfig.apiKey ? `${updatedConfig.apiKey.slice(0, 4)}...${updatedConfig.apiKey.slice(-4)}` : '',
      hasApiKey: Boolean(updatedConfig.apiKey),
    },
  });
});

// Sync from Airtable directly or simulate with custom/live schema
app.post('/api/airtable/sync', async (req, res) => {
  const { venueId, userEmail } = req.body;
  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to sync factory ingredients.' });
  }

  let callerAgencyId = 'agency-hkc';
  let callerName = 'System';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      callerName = caller.name;
    }
  }

  const config =
    airtableConfigs.find((c) => c.venueId === venueId && c.agencyId === callerAgencyId) ||
    airtableConfigs.find((c) => c.agencyId === callerAgencyId);

  if (!config || !config.baseId || !config.tableName) {
    return res.status(400).json({
      error: 'Airtable Base ID and Table Name must be configured before syncing.',
      needsConfig: true,
    });
  }

  // If live Airtable Personal Access Token (PAT) is supplied, query Airtable REST API
  if (config.apiKey && config.apiKey.startsWith('pat')) {
    try {
      const url = `https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tableName)}${config.viewName ? `?view=${encodeURIComponent(config.viewName)}` : ''}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        return res.status(response.status).json({
          error: `Airtable API Error (${response.status}): ${errBody}`,
        });
      }

      const data = await response.json();
      const records = data.records || [];

      const mapping = config.fieldNameMapping || {};
      const nameKey = mapping.ingredientName || 'Ingredient Name';
      const brandKey = mapping.brandOrSupplier || 'Manufacturer / Supplier';
      const agencyKey = mapping.kashrutAgency || 'Kosher Certification Body';
      const kosherKey = mapping.kosherStatus || 'Kosher Designation';
      const lotKey = mapping.lotNumber || 'Lot / Batch Number';
      const dateKey = mapping.approvalDate || 'Approval Date';
      const approverKey = mapping.approvedBy || 'Rabbinic Approver';
      const notesKey = mapping.notes || 'Mashgiach Notes';
      const statusKey = mapping.status || 'Status';

      const syncedIngredients: ApprovedIngredientItem[] = records.map((rec: any) => {
        const fields = rec.fields || {};
        const rawKosher = String(fields[kosherKey] || fields['Kosher Status'] || fields['Category'] || 'Parve');
        let kosherStatus: any = 'Parve';
        if (/dairy/i.test(rawKosher)) kosherStatus = 'Dairy';
        else if (/meat/i.test(rawKosher)) kosherStatus = 'Meat';
        else if (/cholov/i.test(rawKosher)) kosherStatus = 'Cholov Yisroel';
        else if (/pas/i.test(rawKosher)) kosherStatus = 'Pas Yisroel';

        return {
          id: `ing_at_${rec.id}`,
          airtableRecordId: rec.id,
          venueId: String(venueId),
          agencyId: callerAgencyId,
          name: String(fields[nameKey] || fields['Name'] || fields['Ingredient'] || 'Unnamed Ingredient'),
          brandOrSupplier: String(fields[brandKey] || fields['Supplier'] || fields['Brand'] || 'Specified Vendor'),
          kashrutAgency: String(fields[agencyKey] || fields['Certification'] || 'Approved Agency'),
          kosherStatus,
          lotOrBatch: fields[lotKey] ? String(fields[lotKey]) : undefined,
          approvalStatus: (String(fields[statusKey] || 'approved').toLowerCase().includes('pending') ? 'pending_approval' : 'approved') as any,
          approvalDate: fields[dateKey] ? String(fields[dateKey]) : new Date().toISOString().split('T')[0],
          approvedBy: fields[approverKey] ? String(fields[approverKey]) : `${callerName} (Agency)`,
          notes: fields[notesKey] ? String(fields[notesKey]) : undefined,
          verificationStatus: 'unverified',
          verificationNotes: '',
        };
      });

      // Replace or merge into approvedIngredients for this venue
      approvedIngredients = [
        ...approvedIngredients.filter((i) => i.venueId !== venueId),
        ...syncedIngredients,
      ];
      config.lastSyncedAt = new Date().toISOString();
      saveState();

      broadcast('INGREDIENTS_SYNCED', {
        venueId,
        agencyId: callerAgencyId,
        ingredients: approvedIngredients.filter((i) => i.venueId === venueId),
        count: syncedIngredients.length,
        syncedAt: config.lastSyncedAt,
      });

      return res.json({
        success: true,
        source: 'airtable_live_api',
        count: syncedIngredients.length,
        ingredients: approvedIngredients.filter((i) => i.venueId === venueId),
        syncedAt: config.lastSyncedAt,
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Failed to fetch from Airtable: ${err.message}` });
    }
  }

  // If testing / demo mode without live PAT, refresh default ingredients with timestamp
  config.lastSyncedAt = new Date().toISOString();
  saveState();

  const venueIngredients = approvedIngredients.filter((i) => i.venueId === venueId);
  broadcast('INGREDIENTS_SYNCED', {
    venueId,
    agencyId: callerAgencyId,
    ingredients: venueIngredients,
    count: venueIngredients.length,
    syncedAt: config.lastSyncedAt,
  });

  res.json({
    success: true,
    source: 'airtable_configured_sync',
    count: venueIngredients.length,
    ingredients: venueIngredients,
    syncedAt: config.lastSyncedAt,
  });
});

// Get Approved Ingredients for a Venue
app.get('/api/ingredients', (req, res) => {
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

  let items = approvedIngredients.filter((i) => (i.agencyId || 'agency-hkc') === callerAgencyId);
  if (venueId) {
    items = items.filter((i) => i.venueId === venueId);
  }

  res.json({ ingredients: items });
});

// Mashgiach verifies or flags an approved ingredient during factory visit
app.put('/api/ingredients/:id/verify', (req, res) => {
  const { id } = req.params;
  const { verificationStatus, verificationNotes, userEmail } = req.body;

  const itemIndex = approvedIngredients.findIndex((i) => i.id === id);
  if (itemIndex === -1) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }

  let verifiedByName = 'Factory Mashgiach';
  let verifiedByEmail = userEmail || null;

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      verifiedByName = caller.name;
      verifiedByEmail = caller.email;
    }
  }

  const existing = approvedIngredients[itemIndex];
  const updated: ApprovedIngredientItem = {
    ...existing,
    verificationStatus: verificationStatus || 'verified_present',
    verificationNotes: verificationNotes !== undefined ? verificationNotes : existing.verificationNotes,
    verifiedAt: verificationStatus === 'unverified' ? null : new Date().toISOString(),
    verifiedByName: verificationStatus === 'unverified' ? null : verifiedByName,
    verifiedByEmail: verificationStatus === 'unverified' ? null : verifiedByEmail,
  };

  approvedIngredients[itemIndex] = updated;
  saveState();

  broadcast('INGREDIENT_VERIFIED', {
    ingredient: updated,
    venueId: updated.venueId,
    agencyId: updated.agencyId,
  });

  res.json({ success: true, ingredient: updated });
});

// Add new Approved Ingredient (Agency Admin or Coordinator)
app.post('/api/ingredients', (req, res) => {
  const { venueId, name, brandOrSupplier, kashrutAgency, kosherStatus, lotOrBatch, notes, userEmail } = req.body;
  if (!venueId || !name) {
    return res.status(400).json({ error: 'Venue ID and ingredient name are required.' });
  }

  let callerAgencyId = 'agency-hkc';
  let approverName = 'HKC Rabbinic Council';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      approverName = caller.name;
    }
  }

  const newIngredient: ApprovedIngredientItem = {
    id: `ing_${Date.now()}`,
    venueId,
    agencyId: callerAgencyId,
    name: name.trim(),
    brandOrSupplier: brandOrSupplier ? brandOrSupplier.trim() : undefined,
    kashrutAgency: kashrutAgency ? kashrutAgency.trim() : 'HKC Approved',
    kosherStatus: kosherStatus || 'Parve',
    lotOrBatch: lotOrBatch ? lotOrBatch.trim() : undefined,
    approvalStatus: 'approved',
    approvalDate: new Date().toISOString().split('T')[0],
    approvedBy: approverName,
    notes: notes ? notes.trim() : undefined,
    verificationStatus: 'unverified',
  };

  approvedIngredients.push(newIngredient);
  saveState();

  broadcast('INGREDIENT_VERIFIED', {
    ingredient: newIngredient,
    venueId: newIngredient.venueId,
    agencyId: newIngredient.agencyId,
  });

  res.status(201).json({ success: true, ingredient: newIngredient });
});

// Delete an ingredient
app.delete('/api/ingredients/:id', (req, res) => {
  const { id } = req.params;
  const index = approvedIngredients.findIndex((i) => i.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }

  const deleted = approvedIngredients[index];
  approvedIngredients.splice(index, 1);
  saveState();

  broadcast('INGREDIENTS_SYNCED', {
    venueId: deleted.venueId,
    agencyId: deleted.agencyId,
    deletedId: id,
    ingredients: approvedIngredients.filter((i) => i.venueId === deleted.venueId),
  });

  res.json({ success: true, deletedId: id });
});

// Factory Audit Reports: Get List
app.get('/api/factory-reports', (req, res) => {
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

  let reports = factoryReports.filter((r) => r.agencyId === callerAgencyId);
  if (venueId) {
    reports = reports.filter((r) => r.venueId === venueId);
  }

  // Sort newest first
  reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ reports });
});

// Factory Audit Reports: Submit New Mashgiach Inspection Report
app.post('/api/factory-reports', (req, res) => {
  const {
    venueId,
    auditDate,
    startTime,
    endTime,
    factoryRepresentative,
    auditedIngredients,
    discrepancies,
    summaryNotes,
    status,
    mashgiachSigned,
    userEmail,
  } = req.body;

  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to submit a factory report.' });
  }

  const venue = venues.find((v) => v.id === venueId);
  let callerAgencyId = venue?.agencyId || 'agency-hkc';
  let mashgiachName = 'Rabbi Shimon Klein (Factory Mashgiach)';
  let mashgiachEmail = userEmail || 'factory.mashgiach@hartfordkashrut.org';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || callerAgencyId;
      mashgiachName = caller.name;
      mashgiachEmail = caller.email;
    }
  }

  const cleanDiscrepancies: UnapprovedDiscrepancyItem[] = Array.isArray(discrepancies)
    ? discrepancies.map((d: any) => ({
        id: d.id || `disc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        name: String(d.name || 'Unlabeled Raw Material'),
        brandOrSupplier: d.brandOrSupplier ? String(d.brandOrSupplier) : undefined,
        kashrutSymbolFound: d.kashrutSymbolFound ? String(d.kashrutSymbolFound) : 'None / Non-Kosher',
        lotOrBatch: d.lotOrBatch ? String(d.lotOrBatch) : undefined,
        locationInFactory: d.locationInFactory ? String(d.locationInFactory) : 'Factory Floor',
        severity: d.severity || 'warning',
        notes: String(d.notes || ''),
        actionTaken: d.actionTaken ? String(d.actionTaken) : 'Quarantined by Mashgiach',
        photoUrl: d.photoUrl || undefined,
        reportedAt: new Date().toISOString(),
        reportedByName: mashgiachName,
        reportedByEmail: mashgiachEmail,
      }))
    : [];

  const cleanAuditedIngredients = Array.isArray(auditedIngredients) ? auditedIngredients : [];
  const totalApprovedChecked = cleanAuditedIngredients.length;
  const totalPresent = cleanAuditedIngredients.filter((i) => i.status === 'verified_present').length;
  const totalDiscrepancies = cleanDiscrepancies.length;

  const newReport: FactoryAuditReportItem = {
    id: `rpt_${Date.now()}`,
    agencyId: callerAgencyId,
    venueId,
    venueName: venue?.name || 'Kosher Food Manufacturing Plant',
    auditDate: auditDate || new Date().toISOString().split('T')[0],
    startTime: startTime || '09:00 AM',
    endTime: endTime || '14:30 PM',
    mashgiachName,
    mashgiachEmail,
    factoryRepresentative: factoryRepresentative ? String(factoryRepresentative).trim() : 'Plant QA Manager',
    totalApprovedChecked,
    totalPresent,
    totalDiscrepancies,
    auditedIngredients: cleanAuditedIngredients,
    discrepancies: cleanDiscrepancies,
    summaryNotes: summaryNotes ? String(summaryNotes).trim() : 'Routine factory ingredient audit completed.',
    status: status || (totalDiscrepancies > 0 ? 'critical_violation_found' : 'passed'),
    mashgiachSigned: Boolean(mashgiachSigned),
    signatureTimestamp: mashgiachSigned ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString(),
  };

  factoryReports.unshift(newReport);
  saveState();

  broadcast('AUDIT_REPORT_SUBMITTED', {
    report: newReport,
    venueId,
    agencyId: callerAgencyId,
  });

  res.status(201).json({ success: true, report: newReport });
});


// Vite middleware for development & static serving for production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WorkPulse Server] Listening on http://0.0.0.0:${PORT} with WebSockets enabled at /ws`);
  });
}

startServer();
