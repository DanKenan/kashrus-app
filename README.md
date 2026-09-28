# Hartford Kashrut Commission (HKC) - Kosher Audit & Task Management Platform

A real-time collaborative task, audit, and compliance dashboard built for kosher supervision agencies, facility owners, mashgichim (field supervisors), and administrators.

---

## 🌟 Key Features

- **Multi-Role Access Control (RBAC)**:
  - **Admin**: Full oversight across all certified venues, agency configuration, user management, and audit trail export.
  - **Facility Owner / Manager**: Dedicated portal for monitoring venue compliance, viewing inspection logs, and assigning internal tasks.
  - **Mashgiach / Field Inspector**: Quick-access task checklist, photo upload verification, temperature and shift logging, and real-time completion status.
- **Real-Time Collaboration**:
  - WebSocket-powered live task updates and presence across all active sessions.
  - In-app alerts, daily task board resets, and shift reporting.
- **Kashrut Compliance Suite**:
  - Daily routine inspection checklists (Bishul Yisroel, Bedikat Tola'im / vegetable checking, seal verification, meat & dairy separation).
  - Temperature logs, delivery manifests, and discrepancy reporting.
  - Certificate generation and agency branding.
- **PWA & Mobile-Ready**:
  - Installable Progressive Web App (PWA) with offline-tolerant capabilities.
  - Clean responsive UI with light and dark mode support.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm` or `bun`

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/<your-username>/<your-repo-name>.git
   cd <your-repo-name>
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

### Running Locally

To start the full-stack development server (Express backend + Vite React frontend):

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Building for Production

To create a production build:

```bash
npm run build
```

To run the production server:

```bash
npm start
```

---

## 📁 Project Structure

```text
├── data/                  # Local persistence store (JSON-based, gitignored)
├── public/                # Static assets, icons, manifest.webmanifest
├── src/
│   ├── components/        # React components (modals, task lists, dashboards)
│   ├── lib/               # Utilities, permissions, and helper functions
│   ├── types.ts           # TypeScript interfaces and data models
│   ├── App.tsx            # Main application shell
│   └── main.tsx           # React entrypoint
├── server.ts              # Express API server & WebSocket hub
├── vite.config.ts         # Vite configuration with PWA support
└── package.json           # Scripts and dependencies
```

---

## 🔒 Security Note

All database records, credentials, and live data in `data/` and `.env` are excluded from version control via `.gitignore`. Never commit API keys or production secrets to source repositories.
