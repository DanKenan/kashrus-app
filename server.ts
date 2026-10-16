import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeApp, getApps, getApp } from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import webpush from 'web-push';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Auth: bcrypt passwords + signed session tokens (HMAC-SHA256 JWT)
// ---------------------------------------------------------------------------

// JWT signing secret: env first, else generated once and persisted with state
// (same pattern as VAPID keys) so tokens survive restarts and deploys.
let jwtSecret: string | null = null;

function getJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    try {
      saveState();
    } catch {
      // saveState defined below; first call happens after boot anyway
    }
  }
  return jwtSecret;
}

function isBcryptHash(s: unknown): boolean {
  return (
    typeof s === 'string' &&
    (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'))
  );
}

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** Returns 'valid' | 'valid-needs-upgrade' (legacy plaintext matched) | 'invalid'. */
async function checkPassword(
  plain: string,
  stored?: string
): Promise<'valid' | 'valid-needs-upgrade' | 'invalid'> {
  if (!stored || typeof stored !== 'string') return 'invalid';
  if (isBcryptHash(stored)) {
    return (await bcrypt.compare(plain, stored)) ? 'valid' : 'invalid';
  }
  // Legacy plaintext password: verify, then the caller upgrades it to bcrypt.
  return stored === plain ? 'valid-needs-upgrade' : 'invalid';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days

function signToken(userId: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const sig = base64url(
    crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

function verifyToken(token: string): { userId: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = base64url(
      crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
    );
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof data.sub !== 'string' || !data.sub) return null;
    return { userId: data.sub };
  } catch {
    return null;
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();
const server = http.createServer(app);

app.use(express.json());

// ---------------------------------------------------------------------------
// Request authentication + custom-domain agency resolution.
// Every /api route except the public ones below requires a signed session
// token (issued at login / kiosk PIN login). The middleware verifies the
// token and FORCES the verified user's email into the request, so the
// existing per-endpoint agency-scoping logic (which keys off userEmail)
// becomes trustworthy — clients can no longer impersonate anyone by
// sending an arbitrary email address.
// ---------------------------------------------------------------------------

const PUBLIC_API_ROUTES: Array<{ method: string; path: string }> = [
  // Note: req.path inside app.use('/api') is stripped of the /api prefix.
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/setup' },
  { method: 'POST', path: '/agencies/register' },
  { method: 'GET', path: '/push/public-key' },
  { method: 'GET', path: '/agencies/by-domain' },
  // Kiosk: the PIN itself is the credential; /kiosk/users only returns names.
  { method: 'GET', path: '/kiosk/users' },
  { method: 'POST', path: '/kiosk/login' },
  // Kiosk setup: venue names only (no sensitive data) so a fresh tablet can
  // pick its establishment before anyone logs in.
  { method: 'GET', path: '/kiosk/venues' },
];

function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.some((r) => r.method === method && r.path === path);
}

// Custom domains: agencyId -> hostname (e.g. app.hartfordkashrut.org).
// Agencies map in state; entries added via agency settings.
function agencyIdForHostname(hostname: string): string | null {
  const host = hostname.split(':')[0].toLowerCase();
  for (const a of agencies as Array<{ id: string; customDomain?: string }>) {
    if (a.customDomain && a.customDomain.toLowerCase() === host) return a.id;
  }
  return null;
}

app.use('/api', (req, res, next) => {
  // Resolve agency from custom domain when present (used by login/agency pages).
  const domainAgencyId = agencyIdForHostname(req.hostname || '');
  if (domainAgencyId) {
    (req as any).domainAgencyId = domainAgencyId;
  }

  if (isPublicApiRoute(req.method, req.path)) return next();

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = token ? verifyToken(token) : null;
  const user = payload ? users.find((u) => u.id === payload.userId) : undefined;

  if (!user) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }

  // Force the verified identity: endpoints keying off userEmail now see the
  // authenticated user, never a client-supplied impersonation.
  (req as any).authUser = user;
  if (req.query && typeof req.query === 'object') {
    (req.query as any).userEmail = user.email;
  }
  if (req.body && typeof req.body === 'object') {
    (req.body as any).userEmail = user.email;
  }
  next();
});

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
  /** Custom hostname for this agency's portal (e.g. app.hartfordkashrut.org). */
  customDomain?: string;
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
  categories?: string[]; // All assigned categories; categories[0] is the primary
  inputType: 'toggle' | 'yes_no' | 'status_select' | 'checkbox' | 'check_in';
  customStatusOptions?: string[];
  completedStatusValues?: string[];
  assignedTo: string[]; // ['all'] or array of worker emails
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek: number[]; // 0-6
  specificDates?: string[]; // 'YYYY-MM-DD'
  targetTime?: string;
  targetTimeMinutes?: number; // minutes since midnight, set by the structured time picker
  targetTime2?: string; // optional second daily time (e.g. morning + afternoon)
  targetTime2Minutes?: number;
  priority?: 'low' | 'medium' | 'high';
  enableOverdueAlert?: boolean; // if true, send push notification when overdue
  currentStatus: string;
  isCompleted: boolean;
  notes: string;
  updatedByEmail: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  createdAt: string;
  checkIns?: TaskCheckInItem[];
  sortOrder?: number;
  isPrivate?: boolean;
}

interface TaskCheckInItem {
  id: string;
  byName: string | null;
  byEmail: string | null;
  at: string; // ISO timestamp
}

/** Minutes after midnight for a target time like "09:00 AM" / "14:30"; Infinity when none. */
function targetTimeMinutes(t: string | undefined | null): number {
  if (!t) return Infinity;
  const s = t.trim();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    if (/^[Pp]/.test(m12[3])) h += 12;
    return h * 60 + parseInt(m12[2], 10);
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  return Infinity;
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

interface HandoffNote {
  id: string;
  agencyId?: string;
  venueId: string;
  authorEmail: string;
  authorName: string;
  content: string;
  shift: string; // e.g. "Morning", "Afternoon", "Evening"
  createdAt: string;
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
  kioskPin?: string; // 4-6 digit PIN for shared kiosk tablets (never sent to clients)
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

const DEFAULT_VENUES: Venue[] = [];

const DEFAULT_USERS: UserProfile[] = [
  { id: 'usr_admin', agencyId: 'agency-hkc', email: 'kenan@hartfordkashrut.org', name: 'Kenan (Admin)', role: 'admin', avatarColor: '#3b82f6', password: '' },
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

interface EventTaskTemplate {
  id: string;
  title: string;
  agencyId?: string;
  sortOrder: number;
}

function getSafeUser(user: UserProfile) {
  const { password, kioskPin, ...safe } = user;
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

const INITIAL_TASKS: TaskItem[] = [];

const INITIAL_HISTORY: HistoryLog[] = [];

let agencies: Agency[] = [...DEFAULT_AGENCIES];
let venues: Venue[] = [...DEFAULT_VENUES];
let tasks: TaskItem[] = [...INITIAL_TASKS];
let historyLogs: HistoryLog[] = [...INITIAL_HISTORY];
let users: UserProfile[] = [...DEFAULT_USERS];
let handoffNotes: HandoffNote[] = [];
let eventTaskTemplates: EventTaskTemplate[] = [];
let currentWorkDate = new Date().toISOString().split('T')[0];
let isDemoCleared = false;

const INITIAL_EVENTS: KosherEventItem[] = [];

let events: KosherEventItem[] = [...INITIAL_EVENTS];

const INITIAL_AIRTABLE_CONFIGS: AirtableConfigItem[] = [];

const INITIAL_APPROVED_INGREDIENTS: ApprovedIngredientItem[] = [];

let airtableConfigs: AirtableConfigItem[] = [...INITIAL_AIRTABLE_CONFIGS];
let approvedIngredients: ApprovedIngredientItem[] = [...INITIAL_APPROVED_INGREDIENTS];
let factoryReports: FactoryAuditReportItem[] = [];

// Web Push (phone notifications): per-user browser subscriptions + VAPID keys.
// VAPID keys come from env when set; otherwise generated once and persisted
// with the rest of the state so subscriptions survive restarts and deploys.
interface PushSubscriptionRecord {
  userEmail: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}
let pushSubscriptions: PushSubscriptionRecord[] = [];
let vapidKeys: { publicKey: string; privateKey: string } | null = null;

// Load persisted state if exists
// Hydrate all in-memory state from a parsed snapshot (local file or Firestore).
function hydrateState(parsed: any) {
  try {
      if (parsed.isDemoCleared !== undefined) {
        isDemoCleared = Boolean(parsed.isDemoCleared);
      }

      // Web Push state survives regardless of demo mode
      if (Array.isArray(parsed.pushSubscriptions)) {
        pushSubscriptions = parsed.pushSubscriptions.filter(
          (s: any) => s && s.endpoint && s.userEmail && s.keys
        );
      }
      // Persisted VAPID keys only win when env vars are not set (env takes precedence)
      if (
        !process.env.VAPID_PUBLIC_KEY &&
        parsed.vapidKeys &&
        parsed.vapidKeys.publicKey &&
        parsed.vapidKeys.privateKey
      ) {
        vapidKeys = {
          publicKey: parsed.vapidKeys.publicKey,
          privateKey: parsed.vapidKeys.privateKey,
        };
      }
      // Persisted JWT secret only wins when JWT_SECRET env is not set.
      if (!process.env.JWT_SECRET && typeof parsed.jwtSecret === 'string' && parsed.jwtSecret.length >= 32) {
        jwtSecret = parsed.jwtSecret;
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
        handoffNotes = Array.isArray(parsed.handoffNotes) ? parsed.handoffNotes : [];
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
              // Role change resets to a random temp password (hashed) — admin sets a real one.
              password: bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10),
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

        if (Array.isArray(parsed.eventTaskTemplates)) {
          eventTaskTemplates = parsed.eventTaskTemplates.filter(
            (t: any) => t && t.id && t.title
          );
        } else {
          eventTaskTemplates = [];
        }
      }

      if (parsed.currentWorkDate) currentWorkDate = parsed.currentWorkDate;
  } catch (err) {
    console.warn('Could not hydrate state:', err);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      hydrateState(JSON.parse(raw));
    }
  } catch (err) {
    console.warn('Could not read store.json, using defaults:', err);
  }
}

// Single snapshot of everything the server persists.
function stateSnapshot() {
  return {
    agencies,
    venues,
    tasks,
    historyLogs,
    handoffNotes,
    users,
    events,
    eventTaskTemplates,
    airtableConfigs,
    approvedIngredients,
    factoryReports,
    currentWorkDate,
    isDemoCleared,
    pushSubscriptions,
    vapidKeys,
    jwtSecret,
  };
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save store.json:', err);
  }
  // Best-effort durable save to Firestore (never blocks, never throws).
  persistToFirestore();
}

// ---------------------------------------------------------------------------
// Firestore durable persistence.
//
// The local store.json lives on the container's ephemeral filesystem: every
// deploy or server restart wipes it. Firestore is the durable copy.
// Writes are best-effort and never block request handling; if Firestore is
// unreachable (e.g. local dev without GCP credentials) the app keeps working
// exactly as before on the local file.
// ---------------------------------------------------------------------------
const FIRESTORE_STATE_DOC = 'app-state/main';
let firestoreDb: any = null;
// Set true once we've successfully applied Firestore state (or confirmed no
// doc exists yet). persistToFirestore() refuses to write until this is true,
// so a slow/failed boot can never overwrite good data with seed defaults.
let durableStateLoaded = false;

function getFirestoreConfig(): { projectId?: string; databaseId?: string } {
  let fileConfig: any = {};
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    // config file not present — env vars still work
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || fileConfig.projectId,
    databaseId: process.env.FIRESTORE_DATABASE_ID || fileConfig.firestoreDatabaseId,
  };
}

function initFirestore() {
  try {
    // Only attempt Firestore where GCP credentials can exist: Cloud Run
    // (K_SERVICE is always set there), an explicit service-account key, or an
    // explicit opt-in. Anywhere else the ADC lookup would hang and fail, so
    // stay on the local file.
    const mayHaveCredentials =
      process.env.K_SERVICE ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIRESTORE_ENABLED === 'true';
    if (!mayHaveCredentials) {
      console.log('[Firestore] Not on Cloud Run — durable persistence disabled (file only).');
      return;
    }
    const { projectId, databaseId } = getFirestoreConfig();
    if (!projectId) {
      console.log('[Firestore] No project configured — durable persistence disabled (file only).');
      return;
    }
    const app = getApps().length > 0 ? getApp() : initializeApp({ projectId });
    firestoreDb = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
    console.log(`[Firestore] Durable persistence enabled (db: ${databaseId || '(default)'}).`);
  } catch (err: any) {
    firestoreDb = null;
    console.warn('[Firestore] Init failed — durable persistence disabled (file only):', err?.message);
  }
}

// Load durable state at boot. Returns true when Firestore had state to apply.
// Sets durableStateLoaded so persistToFirestore() knows it's safe to write.
async function loadStateFromFirestore(): Promise<boolean> {
  if (!firestoreDb) return false;
  try {
    const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    if (!snap.exists) {
      console.log('[Firestore] No saved state yet — starting from local file.');
      durableStateLoaded = true; // Nothing to overwrite; in-memory is the baseline.
      return false;
    }
    hydrateState(snap.data());
    durableStateLoaded = true;
    console.log('[Firestore] Loaded durable state.');
    return true;
  } catch (err: any) {
    console.warn('[Firestore] Could not load state:', err?.message);
    return false;
  }
}

// Fire-and-forget durable write. Safe to call from sync code paths.
function persistToFirestore() {
  if (!firestoreDb) return;
  // NEVER overwrite Firestore with state that wasn't loaded from it. If a boot
  // is slow or failing, writing now would destroy the user's real data.
  if (!durableStateLoaded) {
    console.warn('[Firestore] Skipping persist — durable state not yet loaded.');
    return;
  }
  try {
    // Firestore rejects `undefined` field values with a *synchronous* throw
    // inside .set() (a promise .catch() cannot catch it), and that throw used
    // to escape into the request as a 500 HTML page. Strip undefineds with a
    // JSON round-trip and keep the whole write guarded so a Firestore failure
    // can never break the API response.
    const payload = JSON.parse(JSON.stringify({ ...stateSnapshot(), savedAt: Date.now() }));
    firestoreDb
      .doc(FIRESTORE_STATE_DOC)
      .set(payload)
      .catch((err: any) => console.warn('[Firestore] Background save failed:', err?.message));
  } catch (err: any) {
    console.warn('[Firestore] Background save failed:', err?.message);
  }
}

/** Backfill sortOrder for tasks that predate the manual-order feature,
 *  per venue, ordered by target time then creation. Idempotent.
 *  MUST run after the Firestore load (see startServer) — the async hydrate
 *  overwrites in-memory tasks, so a module-level call gets wiped. */
function taskSortMinutes(t: { targetTime?: string; targetTimeMinutes?: number }): number {
  // Explicit picker value wins; fall back to parsing the free-text time.
  if (typeof t.targetTimeMinutes === 'number') return t.targetTimeMinutes;
  return targetTimeMinutes(t.targetTime);
}

function normalizeTaskOrder(): boolean {
  let changed = false;
  const venueIds = [...new Set(tasks.map((t) => t.venueId))];
  for (const vid of venueIds) {
    const group = tasks
      .filter((t) => t.venueId === vid)
      .sort(
        (a, b) =>
          taskSortMinutes(a) - taskSortMinutes(b) ||
          a.createdAt.localeCompare(b.createdAt)
      );
    if (group.some((t) => t.sortOrder === undefined)) {
      group.forEach((t, i) => {
        t.sortOrder = i;
      });
      changed = true;
    }
  }
  return changed;
}

loadState();

/** Ensure VAPID keys exist: env vars win, else persisted, else generate once. */
function ensureVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  } else if (!vapidKeys) {
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    console.log('[Push] Generated VAPID keys (persisted with app state).');
    saveState();
  }
  webpush.setVapidDetails(
    'mailto:kenan@hartfordkashrut.org',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

/** Send a push notification to every device a user subscribed. Fire-and-forget. */
function sendPushToUser(userEmail: string, title: string, body: string, data?: any) {
  if (!vapidKeys) return;
  const email = userEmail.trim().toLowerCase();
  const subs = pushSubscriptions.filter((s) => s.userEmail.toLowerCase() === email);
  for (const sub of subs) {
    const payload = JSON.stringify({ title, body, data: data || {} });
    webpush
      .sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys } as any,
        payload
      )
      .catch((err: any) => {
        // 410/404 = subscription is gone; drop it instead of retrying forever
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
          saveState();
        } else {
          console.warn('[Push] Send failed:', err?.message || err);
        }
      });
  }
}

// Check for overdue tasks and notify assigned users (runs every 15 min)
// Tracks already-notified tasks to avoid spam
const overdueNotified = new Set<string>();
function checkOverdueTasks() {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = now.toISOString().split('T')[0];

  for (const task of tasks) {
    if (task.isCompleted) continue;
    if (!task.enableOverdueAlert) continue; // Only alert for tasks with alerts enabled
    if (!task.targetTime || task.targetTime === 'End of Day') continue;

    const taskMinutes = taskSortMinutes(task);
    if (taskMinutes >= nowMinutes) continue; // Not overdue yet

    const notifyKey = `${task.id}:${today}`;
    if (overdueNotified.has(notifyKey)) continue; // Already notified today
    overdueNotified.add(notifyKey);

    const venue = venues.find((v) => v.id === task.venueId);
    const venueName = venue?.name || 'your venue';

    // Notify assigned users, or all venue users if assigned to 'all'
    const assigned = Array.isArray(task.assignedTo) ? task.assignedTo : ['all'];
    const notifyEmails = assigned.includes('all')
      ? users.filter((u) => u.venueId === task.venueId || !u.venueId).map((u) => u.email)
      : assigned;

    for (const email of notifyEmails) {
      sendPushToUser(
        email,
        `Overdue: ${task.title}`,
        `${venueName} — was due at ${task.targetTime}`,
        { taskId: task.id, venueId: task.venueId, type: 'overdue' }
      );
    }
  }

  // Clean up old notification keys (keep only today's)
  for (const key of overdueNotified) {
    if (!key.endsWith(`:${today}`)) overdueNotified.delete(key);
  }
}

// Run overdue check every 15 minutes
setInterval(checkOverdueTasks, 15 * 60 * 1000);

// ---- Web Push endpoints ----
app.get('/api/push/public-key', (_req, res) => {
  if (!vapidKeys) return res.status(503).json({ error: 'Push not initialized' });
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const { userEmail, subscription } = req.body as any;
  if (!userEmail || !subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'userEmail and subscription required' });
  }
  const email = String(userEmail).trim().toLowerCase();
  pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  pushSubscriptions.push({
    userEmail: email,
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    createdAt: new Date().toISOString(),
  });
  saveState();
  res.json({ success: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body as any;
  if (endpoint) {
    pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
    saveState();
  }
  res.json({ success: true });
});

// WebSocket Setup
const wss = new WebSocketServer({ server, path: '/ws' });
const activeSockets = new Map<WebSocket, { email: string; name: string; agencyId: string }>();

function agencyStateFor(agencyId: string) {
  const norm = (v?: string) => v || 'agency-hkc';
  return {
    venues: venues.filter((v) => norm(v.agencyId) === agencyId),
    tasks: tasks.filter((t) => norm(t.agencyId) === agencyId),
    historyLogs: historyLogs.filter((h) => norm(h.agencyId) === agencyId),
    events: events.filter((e) => norm(e.agencyId) === agencyId),
    airtableConfigs: airtableConfigs.filter((c) => norm(c.agencyId) === agencyId),
    approvedIngredients: approvedIngredients.filter((i) => norm(i.agencyId) === agencyId),
    factoryReports: factoryReports.filter((r) => norm(r.agencyId) === agencyId),
    users: getSafeUsers().filter((u: any) => norm(u.agencyId) === agencyId),
    currentWorkDate,
  };
}

function broadcast(type: string, payload: any, senderEmail?: string, agencyId?: string) {
  const message = JSON.stringify({
    type,
    payload,
    timestamp: new Date().toISOString(),
    senderEmail,
  });

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Agency-scoped broadcasts only reach that agency's sockets.
    if (agencyId) {
      const meta = activeSockets.get(client);
      if (!meta || meta.agencyId !== agencyId) continue;
    }
    client.send(message);
  }
}

wss.on('connection', (ws, req) => {
  // Token via ?token=… query param (set by the client from its session).
  let authedUser: any = null;
  try {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const payload = token ? verifyToken(token) : null;
    authedUser = payload ? users.find((u) => u.id === payload.userId) : null;
  } catch {
    authedUser = null;
  }

  if (!authedUser) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  const agencyId = authedUser.agencyId || 'agency-hkc';
  activeSockets.set(ws, { email: authedUser.email, name: authedUser.name, agencyId });

  // Initial state: ONLY this user's agency. Never the whole platform.
  ws.send(
    JSON.stringify({
      type: 'INITIAL_STATE',
      payload: {
        ...agencyStateFor(agencyId),
        activeWorkersCount: activeSockets.size,
      },
      timestamp: new Date().toISOString(),
    })
  );

  broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'USER_PRESENCE' && parsed.payload) {
        activeSockets.set(ws, {
          email: authedUser.email,
          name: authedUser.name,
          agencyId,
        });
        broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    activeSockets.delete(ws);
    broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
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
      entries: venueTasks.map((t) => {
        const checkIns = t.checkIns || [];
        const checkInSummary =
          checkIns.length > 0
            ? checkIns
                .map((c) => {
                  const when = (() => {
                    try {
                      return new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } catch {
                      return '';
                    }
                  })();
                  return `${c.byName || c.byEmail || 'Someone'}${when ? ` at ${when}` : ''}`;
                })
                .join('; ')
            : '';
        const archivedNotes = checkInSummary
          ? `${t.notes ? t.notes + '\n' : ''}Checks (${checkIns.length}): ${checkInSummary}`
          : t.notes;
        return {
          id: `entry-${t.id}-${Date.now()}`,
          taskId: t.id,
          taskTitle: t.title,
          category: t.category,
          status: t.currentStatus,
          isCompleted: t.isCompleted,
          notes: archivedNotes,
          completedByEmail: t.updatedByEmail,
          completedByName: t.updatedByName,
          completedAt: t.updatedAt,
        };
      }),
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
      checkIns: [],
    };
  });

  saveState();

  // Broadcast per-agency: each agency's sockets get only their own data.
  for (const a of agencies) {
    const aid = a.id;
    broadcast('DAILY_RESET', {
      venueId: targetVenueId || 'all',
      tasks: tasks.filter((t) => (t.agencyId || 'agency-hkc') === aid),
      historyLogs: historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === aid),
      currentWorkDate,
      snapshot: snapshots[0] || null,
    }, undefined, aid);
  }

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

// Admin data export — download full state as JSON backup (admin only)
app.get('/api/admin/export', (req, res) => {
  const snapshot = stateSnapshot();
  // Strip sensitive fields from export
  const safe = {
    ...snapshot,
    users: (snapshot.users || []).map((u: any) => ({
      ...u,
      password: undefined,
    })),
    jwtSecret: undefined,
    vapidKeys: undefined,
  };
  const filename = `shutfey-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ ...safe, exportedAt: new Date().toISOString() });
});

// Agency dashboard — overview of all venues with task stats (admin/coordinator)
app.get('/api/admin/dashboard', (req, res) => {
  const agencyId = (req as any).agencyId || 'agency-hkc';
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);

  const venueStats = agencyVenues.map((venue) => {
    const venueTasks = tasks.filter((t) => t.venueId === venue.id);
    const completed = venueTasks.filter((t) => t.isCompleted).length;
    const total = venueTasks.length;
    const overdue = venueTasks.filter((t) => {
      if (t.isCompleted) return false;
      // Overdue if target time has passed today
      if (!t.targetTime || t.targetTime === 'End of Day') return false;
      const now = new Date();
      const minutes = taskSortMinutes(t);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      return minutes < nowMinutes;
    }).length;

    // Recent handoff notes (last 3)
    const recentNotes = handoffNotes
      .filter((n) => n.venueId === venue.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);

    return {
      venue,
      totalTasks: total,
      completedTasks: completed,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      overdueTasks: overdue,
      recentNotes,
    };
  });

  // Agency-wide totals
  const allTasks = tasks.filter((t) => {
    const v = venues.find((vv) => vv.id === t.venueId);
    return v && (v.agencyId || 'agency-hkc') === agencyId;
  });

  res.json({
    venues: venueStats,
    totals: {
      venueCount: agencyVenues.length,
      totalTasks: allTasks.length,
      completedTasks: allTasks.filter((t) => t.isCompleted).length,
      totalHandoffNotes: handoffNotes.length,
    },
  });
});

// Shift handoff notes — mashgiach-to-mashgiach communication
app.get('/api/handoff-notes', (req, res) => {
  const venueId = String(req.query.venueId || '');
  const notes = venueId
    ? handoffNotes.filter((n) => n.venueId === venueId)
    : handoffNotes;
  res.json({ notes: notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post('/api/handoff-notes', (req, res) => {
  const { venueId, content, shift, authorEmail, authorName } = req.body || {};
  if (!venueId || !content?.trim()) {
    return res.status(400).json({ error: 'Venue and note content are required.' });
  }
  const note: HandoffNote = {
    id: `handoff-${crypto.randomUUID()}`,
    agencyId: (req as any).agencyId || 'agency-hkc',
    venueId,
    authorEmail: authorEmail || (req as any).userEmail || '',
    authorName: authorName || 'Mashgiach',
    content: String(content).trim(),
    shift: shift || 'General',
    createdAt: new Date().toISOString(),
  };
  handoffNotes.unshift(note);
  saveState();
  // Broadcast to agency
  broadcast('HANDOFF_NOTE', { note }, undefined, note.agencyId);
  res.json({ note });
});

app.delete('/api/handoff-notes/:id', (req, res) => {
  const idx = handoffNotes.findIndex((n) => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found.' });
  const [deleted] = handoffNotes.splice(idx, 1);
  saveState();
  broadcast('HANDOFF_NOTE_DELETED', { id: deleted.id, venueId: deleted.venueId }, undefined, deleted.agencyId);
  res.json({ success: true });
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
    includeStarterTemplates = false,
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
    password: bcrypt.hashSync(adminPassword.trim(), 10),
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
  }, undefined, newAgency.id);

  res.status(201).json({
    success: true,
    message: `Welcome to KeepingKosher! Agency ${cleanAgencyName} has been established.`,
    agency: newAgency,
    user: getSafeUser(adminUser),
    token: signToken(adminUser.id),
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
  const { userEmail, name, shortCode, certificationSeal, region, contactPhone, customDomain } = req.body;
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

  // Custom domain must be unique across agencies (case-insensitive).
  if (customDomain !== undefined && customDomain.trim() !== '') {
    const normalized = customDomain.trim().toLowerCase();
    const clash = agencies.find(
      (a) => a.id !== agencyId && a.customDomain && a.customDomain.toLowerCase() === normalized
    );
    if (clash) {
      return res.status(409).json({ error: 'That domain is already assigned to another agency.' });
    }
  }

  agencies[index] = {
    ...agencies[index],
    name: name !== undefined ? name.trim() : agencies[index].name,
    shortCode: shortCode !== undefined ? shortCode.trim() : agencies[index].shortCode,
    certificationSeal: certificationSeal !== undefined ? certificationSeal.trim() : agencies[index].certificationSeal,
    region: region !== undefined ? region.trim() : agencies[index].region,
    contactPhone: contactPhone !== undefined ? contactPhone.trim() : agencies[index].contactPhone,
    customDomain: customDomain !== undefined ? customDomain.trim().toLowerCase() || undefined : agencies[index].customDomain,
  };

  saveState();
  broadcast('AGENCY_UPDATED', { agency: agencies[index] }, userEmail, agencyId);
  res.json({ success: true, agency: agencies[index] });
});

// Resolve the agency for the current hostname (custom-domain portals).
// Public: the login page uses this to show the agency's name on their domain.
app.get('/api/agencies/by-domain', (req, res) => {
  const host = String(req.hostname || '').split(':')[0].toLowerCase();
  const agency = agencies.find((a) => a.customDomain && a.customDomain.toLowerCase() === host);
  if (!agency) return res.json({ agency: null });
  res.json({
    agency: {
      id: agency.id,
      name: agency.name,
      shortCode: agency.shortCode,
      certificationSeal: agency.certificationSeal,
    },
  });
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
        password: ownerPassword?.trim() ? bcrypt.hashSync(ownerPassword.trim(), 10) : bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10),
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
  }, undefined, callerAgencyId);

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

  broadcast('VENUE_UPDATED', { venue: updated, agencyId: callerAgencyId }, undefined, callerAgencyId);
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

  broadcast('VENUE_DELETED', { deletedVenueId: id, agencyId: callerAgencyId }, undefined, callerAgencyId);
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
  // Private assignments: only the assignees, coordinators and admins may see them
  const callerEmailNorm = userEmail ? String(userEmail).trim().toLowerCase() : '';
  const callerUser = callerEmailNorm
    ? users.find((u) => u.email.toLowerCase() === callerEmailNorm)
    : undefined;
  const canSeePrivate =
    isCallerAdmin || (callerUser && callerUser.role === 'coordinator');
  const visibleTasks = canSeePrivate
    ? filteredTasks
    : filteredTasks.filter(
        (t) =>
          !t.isPrivate ||
          (callerEmailNorm !== '' &&
            (t.assignedTo || []).some((a) => a.toLowerCase() === callerEmailNorm))
      );
  const activeVenue = agencyVenues.find((v) => v.id === targetVenueId) || agencyVenues[0] || venues[0];

  res.json({
    tasks: visibleTasks,
    venue: activeVenue,
    venueId: targetVenueId,
    currentWorkDate,
    totalTasks: visibleTasks.length,
    completedCount: visibleTasks.filter((t) => t.isCompleted).length,
  });
});

app.post('/api/tasks', (req, res) => {
  const {
    venueId,
    title,
    description,
    category,
    categories,
    isPrivate,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    targetTimeMinutes: targetTimeMinutesBody,
    targetTime2,
    targetTime2Minutes,
    priority,
    enableOverdueAlert,
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

  // Slot the new task into the manual board order by its target time
  // (earliest first); up/down arrows can fine-tune it afterwards.
  const newTimeKey = targetTimeMinutes(targetTime);
  const nowIso = new Date().toISOString();
  const siblings = tasks
    .filter((t) => t.venueId === targetVenueId)
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt)
    );
  let insertAt = siblings.findIndex(
    (t) => targetTimeMinutes(t.targetTime) > newTimeKey || (targetTimeMinutes(t.targetTime) === newTimeKey && t.createdAt > nowIso)
  );
  if (insertAt === -1) insertAt = siblings.length;
  siblings.forEach((t, i) => {
    if (i >= insertAt) t.sortOrder = (t.sortOrder ?? i) + 1;
  });

  const newTask: TaskItem = {
    id: `task-${crypto.randomUUID()}`,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    title,
    description: description || '',
    category: category || 'General',
    categories: Array.isArray(categories) && categories.length > 0 ? categories : [category || 'General'],
    isPrivate: isPrivate === true,
    sortOrder: insertAt,
    inputType: inputType || 'yes_no',
    customStatusOptions: Array.isArray(customStatusOptions) && customStatusOptions.length > 0 ? customStatusOptions : undefined,
    completedStatusValues: Array.isArray(completedStatusValues) && completedStatusValues.length > 0 ? completedStatusValues : undefined,
    assignedTo: Array.isArray(assignedTo) && assignedTo.length > 0 ? assignedTo : ['all'],
    scheduleType: scheduleType === 'specific_dates' ? 'specific_dates' : 'recurring',
    daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6],
    specificDates: Array.isArray(specificDates) ? specificDates : undefined,
    targetTime: targetTime || 'End of Day',
    targetTimeMinutes: targetTimeMinutesBody !== undefined && targetTimeMinutesBody !== null ? Number(targetTimeMinutesBody) : undefined,
    targetTime2: targetTime2 || undefined,
    targetTime2Minutes: targetTime2Minutes !== undefined && targetTime2Minutes !== null ? Number(targetTime2Minutes) : undefined,
    priority: priority || 'medium',
    enableOverdueAlert: enableOverdueAlert === true,
    currentStatus: defaultStatus,
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    checkIns: [],
    createdAt: new Date().toISOString(),
  };

  tasks.push(newTask);
  saveState();

  broadcast('TASK_CREATED', newTask, createdByEmail, newTask.agencyId || 'agency-hkc');

  // Phone push to specifically-assigned mashgichim (not for global 'all' tasks)
  const assignees = (newTask.assignedTo || []).filter(
    (a) => a && a.toLowerCase() !== 'all'
  );
  for (const email of assignees) {
    if (createdByEmail && email.toLowerCase() === createdByEmail.toLowerCase()) continue;
    sendPushToUser(
      email,
      '📋 New task assigned to you',
      `${newTask.title}${newTask.targetTime ? ` — ${newTask.targetTime}` : ''}`,
      { url: '/', taskId: newTask.id }
    );
  }

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
    categories,
    isPrivate,
    sortOrder,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    targetTimeMinutes,
    targetTime2,
    targetTime2Minutes,
    priority,
    enableOverdueAlert,
  } = req.body;

  const hasStatusChange = currentStatus !== undefined || isCompleted !== undefined || notes !== undefined;
  const isDefinitionEdit =
    title !== undefined ||
    description !== undefined ||
    category !== undefined ||
    categories !== undefined ||
    isPrivate !== undefined ||
    sortOrder !== undefined ||
    inputType !== undefined ||
    customStatusOptions !== undefined ||
    completedStatusValues !== undefined ||
    assignedTo !== undefined ||
    scheduleType !== undefined ||
    daysOfWeek !== undefined ||
    specificDates !== undefined ||
    targetTime !== undefined ||
    targetTimeMinutes !== undefined ||
    targetTime2 !== undefined ||
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
    categories: categories !== undefined ? categories : existing.categories,
    isPrivate: isPrivate !== undefined ? isPrivate === true : existing.isPrivate,
    sortOrder: sortOrder !== undefined ? Number(sortOrder) : existing.sortOrder,
    inputType: inputType !== undefined ? inputType : existing.inputType,
    customStatusOptions: customStatusOptions !== undefined ? customStatusOptions : existing.customStatusOptions,
    completedStatusValues: completedStatusValues !== undefined ? completedStatusValues : existing.completedStatusValues,
    assignedTo: assignedTo !== undefined ? assignedTo : existing.assignedTo,
    scheduleType: scheduleType !== undefined ? scheduleType : existing.scheduleType,
    daysOfWeek: daysOfWeek !== undefined ? daysOfWeek : existing.daysOfWeek,
    specificDates: specificDates !== undefined ? specificDates : existing.specificDates,
    targetTime: targetTime !== undefined ? targetTime : existing.targetTime,
    targetTimeMinutes: targetTimeMinutes !== undefined ? (targetTimeMinutes === null ? undefined : Number(targetTimeMinutes)) : existing.targetTimeMinutes,
    targetTime2: targetTime2 !== undefined ? (targetTime2 || undefined) : existing.targetTime2,
    targetTime2Minutes: targetTime2Minutes !== undefined ? (targetTime2Minutes === null ? undefined : Number(targetTime2Minutes)) : existing.targetTime2Minutes,
    priority: priority !== undefined ? priority : existing.priority,
    enableOverdueAlert: enableOverdueAlert !== undefined ? enableOverdueAlert === true : existing.enableOverdueAlert,
    currentStatus: currentStatus !== undefined ? currentStatus : (finalIsCompleted ? existing.currentStatus : 'pending'),
    isCompleted: finalIsCompleted,
    notes: notes !== undefined ? notes : existing.notes,
    updatedByEmail,
    updatedByName,
    updatedAt,
  };

  tasks[index] = updated;
  saveState();

  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
  res.json(updated);
});

// Remove one check-in entry (tapped by mistake, logged in error).
app.delete('/api/tasks/:id/check-in/:checkInId', (req, res) => {
  const { id, checkInId } = req.params;
  const index = tasks.findIndex((t) => t.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { userEmail } = req.body || {};
  const existing = tasks[index];
  const entry = (existing.checkIns || []).find((c: any) => c.id === checkInId);
  if (!entry) {
    return res.status(404).json({ error: 'Check-in not found' });
  }

  // The person who logged it, or anyone with fill permission, can remove it.
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    const isLogger = entry.byEmail && entry.byEmail.toLowerCase() === String(userEmail).trim().toLowerCase();
    const canFill =
      caller &&
      (caller.role === 'admin' ||
        (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
        ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
        (caller.role === 'owner' && caller.permissions?.canFillTasks === true));
    if (!isLogger && !canFill) {
      return res.status(403).json({ error: 'You do not have permission to remove checks.' });
    }
  }

  const now = new Date().toISOString();
  const updated: TaskItem = {
    ...existing,
    checkIns: (existing.checkIns || []).filter((c: any) => c.id !== checkInId),
    updatedAt: now,
  };

  tasks[index] = updated;
  saveState();

  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
  res.json(updated);
});

// Log one repeatable check-in on a task (inputType 'check_in'): every tap
// appends a {byName, byEmail, at} record under the task.
app.post('/api/tasks/:id/check-in', (req, res) => {
  const { id } = req.params;
  const index = tasks.findIndex((t) => t.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { userEmail, userName } = req.body;
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      const canFill =
        caller.role === 'admin' ||
        (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
        ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
        (caller.role === 'owner' && caller.permissions?.canFillTasks === true);
      if (!canFill) {
        return res.status(403).json({ error: 'You do not have permission to log checks.' });
      }
    }
  }

  const existing = tasks[index];
  const now = new Date().toISOString();
  const checkIn: TaskCheckInItem = {
    id: `checkin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    byName: userName || null,
    byEmail: userEmail || null,
    at: now,
  };

  const updated: TaskItem = {
    ...existing,
    checkIns: [...(existing.checkIns || []), checkIn],
    updatedByEmail: userEmail || existing.updatedByEmail || null,
    updatedByName: userName || existing.updatedByName || null,
    updatedAt: now,
  };

  tasks[index] = updated;
  saveState();

  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
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

  broadcast('TASK_DELETED', { id, venueId: deletedTask.venueId, agencyId: deletedTask.agencyId }, undefined, deletedTask.agencyId || 'agency-hkc');
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
  }, undefined, callerAgencyId);

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
  }, undefined, callerAgencyId);

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

// ---- Default event task templates ----
// Admin-defined tasks that pre-fill every new event notification.
// The event creator can delete any that don't apply and add event-specific ones.
app.get('/api/event-task-templates', (req, res) => {
  const { agencyId } = req.query;
  const list = eventTaskTemplates
    .filter((t) => !agencyId || !t.agencyId || t.agencyId === agencyId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json({ templates: list });
});

function canManageTemplates(userEmail: string | undefined): boolean {
  if (!userEmail) return false;
  const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
  return !!caller && (caller.role === 'admin' || caller.role === 'coordinator');
}

app.post('/api/event-task-templates', (req, res) => {
  const { title, agencyId, userEmail } = req.body;
  if (!canManageTemplates(userEmail)) {
    return res.status(403).json({ error: 'Only admins can manage default event tasks.' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  const template: EventTaskTemplate = {
    id: `etpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    title: String(title).trim(),
    agencyId: agencyId || undefined,
    sortOrder: eventTaskTemplates.length,
  };
  eventTaskTemplates.push(template);
  saveState();
  broadcast('EVENT_TEMPLATES_UPDATED', { templates: eventTaskTemplates }, undefined, (req as any).authUser?.agencyId || 'agency-hkc');
  res.json({ template });
});

app.delete('/api/event-task-templates/:id', (req, res) => {
  const { userEmail } = req.body || {};
  if (!canManageTemplates(userEmail)) {
    return res.status(403).json({ error: 'Only admins can manage default event tasks.' });
  }
  const idx = eventTaskTemplates.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found.' });
  eventTaskTemplates.splice(idx, 1);
  saveState();
  broadcast('EVENT_TEMPLATES_UPDATED', { templates: eventTaskTemplates }, undefined, (req as any).authUser?.agencyId || 'agency-hkc');
  res.json({ success: true });
});

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
  }, undefined, callerAgencyId);

  // Phone push to the assigned mashgiach (works even with the app closed)
  if (resolvedMashgiachEmail) {
    const when = newEvent.date ? ` — ${newEvent.date}` : '';
    sendPushToUser(
      resolvedMashgiachEmail,
      '⭐ New event assignment',
      `${newEvent.title}${when} at ${newEvent.location}`,
      { url: '/', eventId: newEvent.id }
    );
  }

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
  }, undefined, updated.agencyId || 'agency-hkc');

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
  }, undefined, deletedEvent.agencyId || 'agency-hkc');

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
  }, undefined, event.agencyId || 'agency-hkc');

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
    (password && String(password).trim()) || crypto.randomBytes(9).toString('hex');

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
    password: bcrypt.hashSync(initialPassword, 10),
  };

  users.push(newUser);
  saveState();
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: callerAgencyId }, undefined, callerAgencyId);
  res.status(201).json({ user: getSafeUser(newUser) });
});

// Update user permissions or role
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const userIndex = users.findIndex((u) => u.id === id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'Team member not found' });
  }

  const { role, permissions, venueId, name, kioskPin } = req.body;
  const existingUser = users[userIndex];

  if (name !== undefined) {
    existingUser.name = name.trim();
  }
  if (kioskPin !== undefined) {
    // 4-6 digit kiosk PIN, or empty string to clear
    const pin = String(kioskPin).trim();
    if (pin === '' || /^[0-9]{4,6}$/.test(pin)) {
      existingUser.kioskPin = pin === '' ? undefined : pin;
    }
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
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: existingUser.agencyId }, undefined, existingUser.agencyId);
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
  broadcast('USERS_UPDATED', { users: getSafeUsers(), deletedId: id, agencyId: userToDelete.agencyId }, undefined, userToDelete.agencyId);
  res.json({ success: true, deletedId: id });
});

// ---- Kiosk mode: shared tablet login via per-user PIN ----
// Public list of PIN-enabled staff for one venue (no PINs, no emails exposed).
// Public venue list for kiosk setup: id + name only, no sensitive data.
// A fresh tablet needs this before anyone logs in.
app.get('/api/kiosk/venues', (req, res) => {
  res.json({
    venues: venues.map((v) => ({ id: v.id, name: v.name })),
  });
});

app.get('/api/kiosk/users', (req, res) => {
  const venueId = String(req.query.venueId || '').trim();
  if (!venueId) return res.status(400).json({ error: 'venueId required' });
  const staff = users
    .filter((u) => u.venueId === venueId && u.kioskPin && ['mashgiach', 'worker', 'coordinator'].includes(u.role))
    .map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role }));
  const venue = venues.find((v) => v.id === venueId);
  res.json({ venueName: venue?.name || 'Kiosk', users: staff });
});

// Verify a kiosk PIN and return the user session (with a signed token, so the
// kiosk session is authenticated like any other login).
app.post('/api/kiosk/login', (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Missing credentials' });
  const user = users.find((u) => u.id === userId);
  if (!user || !user.kioskPin || user.kioskPin !== String(pin).trim()) {
    return res.status(401).json({ error: 'Wrong code. Try again.' });
  }
  res.json({ user: getSafeUser(user), token: signToken(user.id) });
});

// Formal Login Endpoint — bcrypt passwords, signed session token on success.
// Legacy plaintext passwords are transparently upgraded to bcrypt on login.
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter both your email and password.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);

  if (!user) {
    return res.status(401).json({ error: 'Account not found. Please verify your email or ask your admin to register you.' });
  }

  // First-run setup: admin account with no password yet → client shows the
  // "create your password" screen instead of an error.
  if (!user.password && user.role === 'admin') {
    return res.json({ success: false, needsSetup: true, email: user.email });
  }

  // No hardcoded fallback passwords: only the stored (bcrypt) password works.
  const result = await checkPassword(String(password), user.password);
  if (result === 'invalid') {
    return res.status(401).json({ error: 'Incorrect password. Please try again or request a reset.' });
  }
  if (result === 'valid-needs-upgrade') {
    user.password = await hashPassword(String(password));
    saveState();
  }

  const token = signToken(user.id);
  res.json({
    success: true,
    user: getSafeUser(user),
    token,
  });
});

// First-run admin setup: sets the admin password. Public, but ONLY works when
// the admin account has no password yet — it becomes a no-op forever after.
app.post('/api/auth/setup', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword || String(newPassword).trim().length < 8) {
    return res.status(400).json({ error: 'A password of at least 8 characters is required.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const userIndex = users.findIndex((u) => u.email.toLowerCase() === normalizedEmail);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'Account not found.' });
  }
  const user = users[userIndex];
  if (user.role !== 'admin' || user.password) {
    return res.status(403).json({ error: 'Setup is already complete.' });
  }
  users[userIndex].password = await hashPassword(String(newPassword).trim());
  saveState();
  const token = signToken(user.id);
  res.json({ success: true, user: getSafeUser(users[userIndex]), token });
});

// Change Password Endpoint — requires a valid session; the caller can only
// change their OWN password (identity comes from the verified token).
app.post('/api/auth/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are both required.' });
  }

  if (String(newPassword).trim().length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }

  const authUser = (req as any).authUser;
  const userIndex = users.findIndex((u) => u.id === authUser.id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  const user = users[userIndex];
  const result = await checkPassword(String(currentPassword), user.password);
  if (result === 'invalid') {
    return res.status(401).json({ error: 'Current password does not match.' });
  }

  users[userIndex].password = await hashPassword(String(newPassword).trim());
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
      }, undefined, callerAgencyId);

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
  }, undefined, callerAgencyId);

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
  }, undefined, updated.agencyId || 'agency-hkc');

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
  }, undefined, newIngredient.agencyId || 'agency-hkc');

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
  }, undefined, deleted.agencyId || 'agency-hkc');

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
// One-time (per boot) migration: bcrypt-hash any plaintext passwords found in
// state. Already-hashed and empty passwords are left alone.
async function migratePasswordsToBcrypt(): Promise<void> {
  let changed = 0;
  for (const u of users) {
    if (u.password && !isBcryptHash(u.password)) {
      u.password = await hashPassword(u.password);
      changed++;
    }
  }
  if (changed > 0) {
    saveState();
    console.log(`[Auth] Migrated ${changed} plaintext password(s) to bcrypt.`);
  }
}

async function startServer() {
  // Durable state first: Firestore wins over the ephemeral local file.
  // We WAIT for the load — no timeout race. Starting with seed state while
  // Firestore is slow would let the first request overwrite real user data.
  // If Firestore is unreachable, the boot fails loudly instead of corrupting.
  initFirestore();
  if (firestoreDb) {
    const loaded = await loadStateFromFirestore();
    if (!loaded && !durableStateLoaded) {
      throw new Error('[Firestore] Could not load durable state at boot — refusing to start with empty state.');
    }
  } else {
    durableStateLoaded = true; // No Firestore configured; local file is the source of truth.
  }

  // Backfill task ordering AFTER the durable load (the hydrate above replaces
  // in-memory tasks, so this must not run at module level). Persists when it
  // changes anything so the order sticks.
  if (normalizeTaskOrder()) saveState();

  // Web Push: VAPID keys must be ready after durable state loads (env vars
  // take precedence over persisted keys inside ensureVapidKeys).
  ensureVapidKeys();

  // Security migration: hash any legacy plaintext passwords still in state.
  // Runs once per boot; already-hashed passwords are untouched.
  await migratePasswordsToBcrypt();

  if (process.env.NODE_ENV !== 'production') {
    // Dynamic import so production containers don't need vite installed.
    const { createServer: createViteServer } = await import('vite');
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
